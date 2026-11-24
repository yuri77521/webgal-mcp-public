import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';

const scripts = fileURLToPath(new URL('../skills/webgal-librarian/scripts/', import.meta.url));
const server = fileURLToPath(new URL('../dist/cli.js', import.meta.url));

function python(script: string, ...args: string[]) {
  const command = spawnSync('python', ['-X', 'utf8', join(scripts, script), ...args], { encoding: 'utf8' });
  expect(command.status, command.stderr || command.error?.message).toBe(0);
  return command.stdout;
}

it('indexes a nested source using MCP, then finds an expression offline with the original model identity', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'webgal-live2d-handoff-'));
  try {
    const library = join(dir, '素材库');
    await mkdir(library);
    python('library.py', 'init', library);
    const source = join(library, 'Live2D');
    const model = join(source, '冬装');
    await mkdir(model, { recursive: true });
    const expressions = Array.from({ length: 105 }, (_, index) => ({
      name: index === 104 ? 'wink01' : `expr${index}`, file: 'face.exp.json',
    }));
    await Promise.all([
      writeFile(join(model, 'model.json'), JSON.stringify({ model: 'actor.moc',
        textures: ['actor.png'], motions: {}, expressions })),
      writeFile(join(model, 'actor.moc'), 'test'), writeFile(join(model, 'actor.png'), 'test'),
      writeFile(join(model, 'face.exp.json'), '{"params":[]}'),
    ]);
    const config = join(dir, 'config.json');
    await writeFile(config, JSON.stringify({ version: 1, projects: [], sources: [{ id: 'models', root: source }] }));
    python('sync_live2d.py', library, '--server', server, '--config', config, '--source', 'models',
      '--package', '冬装', '--entry', '冬装/model.json', '--character', '爱音', '--model-name', '冬装');
    const result = python('library.py', 'search', library, '--type', 'Live2D', '--group', '爱音',
      '--model', '冬装', '--kind', 'expression', '--term', '眨眼');
    expect(result).toContain('wink01');
    expect(result).toContain('Live2D/冬装/model.json');
    expect(result).not.toContain('expr103');
    const selected = JSON.parse(result).候选[0];
    const detail = python('library.py', 'show', library, '--path', selected.路径);
    expect(detail).toContain('冬装/model.json');
    expect(detail).toContain('"models"');
    // Losing access to the MCP configuration must not break an indexed library.
    await rm(config);
    expect(python('library.py', 'search', library, '--type', 'Live2D', '--group', '爱音',
      '--model', '冬装', '--kind', 'expression', '--term', '眨眼')).toBe(result);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}, 20_000);
