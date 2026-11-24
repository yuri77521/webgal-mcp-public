import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { describe, expect, it } from 'vitest';
import { createServer } from '../src/server.js';
import { ProjectLocks } from '../src/changes/locks.js';
import { applySceneEdits } from '../src/edits/scenes.js';

const projectId = 'station-lab';
const helper = fileURLToPath(new URL('../skills/webgal-editor/scripts/local-edit.mjs', import.meta.url));
const dialogue = '小澪:沒事 -voice.wav;';
const replacement = 'bgm:station.mp3;\r\n小澪:再陪我一下 -voice.wav;';
const original = [':車站 🚉;', dialogue, ':她看了看車票。;', dialogue, ':車來了。;'].join('\r\n');

function snapshot(text: string) {
  const raw = Buffer.from('\ufeff' + text);
  return { path: 'station.txt', source: 'disk', text, encoding: 'utf-8-bom',
    revision: createHash('sha256').update(raw).digest('hex'), bytes: raw.length };
}

function invoke(scene: object, input: object, script = helper) {
  return spawnSync(process.execPath, [script], {
    input: JSON.stringify({ projectId, scene, ...input }), encoding: 'utf8'
  });
}

function run(scene: object, input: object) {
  const result = invoke(scene, input);
  expect(result.status, result.stderr).toBe(0);
  return JSON.parse(result.stdout);
}

function stationEdit(scene: object) {
  const hits = run(scene, { mode: 'find', needle: '沒事' });
  expect(hits.map((hit: { line: number }) => hit.line)).toEqual([2, 4]);
  expect(hits[1].left).toBe(':她看了看車票。;');
  return run(scene, { mode: 'draft', firstLine: hits[1].line, before: dialogue, after: replacement });
}

describe('standalone Editor', () => {
  it('edits a static cue with only Editor installed and picks up an optional sibling for a model cue', async () => {
    const skills = await mkdtemp(path.join(tmpdir(), 'webgal-skills-'));
    const installed = path.join(skills, 'webgal-editor');
    const script = path.join(installed, 'scripts/local-edit.mjs');
    const portrait = 'changeFigure:calm.png -left -next;';
    const model = 'changeFigure:actor/model.json -right -id=actor -next;';
    const scene = snapshot([model, portrait, dialogue].join('\n'));
    const reaction = { mode: 'live2d', firstLine: 3, before: dialogue,
      figure: { modelPath: 'actor/model.json', slot: 'right', id: 'actor' }, expression: 'Smile' };
    try {
      await cp(new URL('../skills/webgal-editor/', import.meta.url), installed, { recursive: true });
      const edit = invoke(scene, { mode: 'draft', firstLine: 2, before: portrait,
        after: portrait.replace('calm.png', 'smile.png') }, script);
      expect(edit.status, edit.stderr).toBe(0);
      expect(JSON.parse(edit.stdout).afterRevision).toBe(snapshot(scene.text.replace('calm.png', 'smile.png')).revision);
      const missing = invoke(scene, reaction, script);
      expect(missing.status).toBe(1);
      expect(missing.stderr).toContain('Install webgal-live2d');
      await cp(new URL('../skills/webgal-live2d/', import.meta.url), path.join(skills, 'webgal-live2d'), { recursive: true });
      const staged = invoke(scene, reaction, script);
      expect(staged.status, staged.stderr).toBe(0);
      expect(JSON.parse(staged.stdout).candidateText).toBe([model, portrait,
        'changeFigure:actor/model.json -id=actor -right -expression=Smile -next;', dialogue].join('\n'));
    } finally {
      await rm(skills, { recursive: true, force: true });
    }
  });

  it('applies verified Live2D selectors at the chosen beat without replacing the figure or spoken line', () => {
    const entry = '冬装 爱音/model.json';
    const intro = `changeFigure:${entry} -left -id=anon -next;`;
    const scene = snapshot([intro, dialogue, dialogue].join('\r\n'));
    const input = { mode: 'live2d', firstLine: 3, before: dialogue,
      figure: { modelPath: entry, slot: 'left', id: 'anon' }, expression: 'wink01' };
    const edit = run(scene, input);
    const expected = [intro, dialogue, `changeFigure:${entry} -id=anon -left -expression=wink01 -next;`, dialogue].join('\r\n');
    expect(edit.candidateText).toBe(expected);
    expect(edit.afterRevision).toBe(snapshot(expected).revision);
    expect(run(snapshot(expected), { mode: 'undo', receipt: edit.receipt }).afterRevision).toBe(scene.revision);
    const combined = run(scene, { ...input, motion: 'sakiko/bow', expression: 'sakiko/cry01' });
    expect(combined.candidateText).toContain('-motion=sakiko/bow -expression=sakiko/cry01');
    expect(invoke(scene, { ...input, expression: 'wink01 -right' }).status).toBe(1);
    expect(invoke(scene, { ...input, before: 'stale' }).status).toBe(1);
  });

  it('inserts music at separate dialogue boundaries and matches the candidate and undo byte for byte', () => {
    const scene = snapshot(original);
    const cues = [
      { line: 1, before: ':車站 🚉;', track: '行程/出發.mp3' },
      { line: 3, before: ':她看了看車票。;', track: '到了.mp3' },
      { line: 4, before: dialogue, track: 'none' },
      { line: 5, before: ':車來了。;', track: '行程/出發.mp3' }
    ];
    const result = run(scene, { mode: 'bgm', cues });
    const expected = ['bgm:行程/出發.mp3 -next;', ':車站 🚉;', dialogue, 'bgm:到了.mp3 -next;',
      ':她看了看車票。;', 'bgm:none -next;', dialogue, 'bgm:行程/出發.mp3 -next;', ':車來了。;'].join('\r\n');
    expect(result.candidateText).toBe(expected);
    expect(result.afterRevision).toBe(snapshot(expected).revision);
    expect(applySceneEdits(Buffer.from('\ufeff' + original), result.operation.edits)).toEqual(Buffer.from('\ufeff' + expected));
    expect(run(snapshot(expected), { mode: 'undo', receipt: result.receipt }).afterRevision).toBe(scene.revision);
    expect(invoke(scene, { mode: 'bgm', cues: [cues[0], cues[0]] }).status).toBe(1);
    expect(invoke(scene, { mode: 'bgm', cues: [{ ...cues[0], track: 'x;end;' }] }).status).toBe(1);
  });

  it('inserts a horizontal move before the selected line and preserves the spoken bytes on undo', () => {
    const text = '角色2:到了。;\n' + dialogue + '\r\n' + dialogue;
    const scene = snapshot(text);
    const move = { mode: 'move', firstLine: 3, before: dialogue, target: '小澪', x: -280, duration: 220 };
    const edit = run(scene, move);
    const cue = 'setTransform:{"position":{"x":-280}} -target=小澪 -duration=220 -ease=easeOut -keep -next;';
    const expected = text.slice(0, text.lastIndexOf(dialogue)) + cue + '\r\n' + dialogue;
    expect(applySceneEdits(Buffer.from('\ufeff' + text), edit.operation.edits)).toEqual(Buffer.from('\ufeff' + expected));
    expect(run(snapshot(expected), { mode: 'undo', receipt: edit.receipt }).afterRevision).toBe(scene.revision);
    expect(invoke(scene, { ...move, before: 'changed' }).status).toBe(1);
    expect(invoke(scene, { ...move, target: 'other;end' }).status).toBe(1);
  });

  it('changes just the second line and its cue; reverses both after an unrelated hand edit', () => {
    const edit = stationEdit(snapshot(original));
    const expected = original.slice(0, original.lastIndexOf(dialogue)) + replacement + '\r\n:車來了。;';
    const actual = applySceneEdits(Buffer.from('\ufeff' + original), edit.operation.edits);
    expect(actual).toEqual(Buffer.from('\ufeff' + expected));
    expect(edit.afterRevision).toBe(snapshot(expected).revision);
    const later = expected.replace('車來了', '車門開了');
    const undo = run(snapshot(later), { mode: 'undo', receipt: edit.receipt });
    expect(applySceneEdits(Buffer.from('\ufeff' + later), undo.operation.edits))
      .toEqual(Buffer.from('\ufeff' + original.replace('車來了', '車門開了')));
    for (const changed of [later.replace('再陪我一下', '我想走了'), later.replace('station.mp3', 'manual.mp3'),
      later + '\r\n' + later]) {
      const conflict = invoke(snapshot(changed), { mode: 'undo', receipt: edit.receipt });
      expect(conflict.status).toBe(1);
      expect(conflict.stderr).toContain('Conflict');
      expect(conflict.stdout).toBe('');
    }
  });

  it('rejects wrong snapshots, changed target rows and cross-project receipts', () => {
    const scene = snapshot(original);
    const draft = { mode: 'draft', firstLine: 4, before: dialogue, after: replacement };
    expect(invoke({ ...scene, text: scene.text + 'x' }, draft).status).toBe(1);
    expect(invoke(scene, { ...draft, firstLine: 3 }).status).toBe(1);
    const { receipt } = run(scene, draft);
    expect(invoke(scene, { mode: 'undo', receipt, projectId: 'another-game' }).status).toBe(1);
  });

  it('round-trips a local expression, pause or narration edit without reserializing unknown commands', () => {
    const lines = [
      'customStage:keep -flag;', 'changeFigure:hero.model3.json -id=hero -expression=Smile -left;',
      'wait:250;', ':月台很安靜。;', 'customStage:keep -flag;'
    ];
    const text = lines.join('\n');
    for (const [index, after] of [
      [1, lines[1]!.replace('Smile', 'Sad')], [2, 'wait:500;'],
      [3, 'playEffect:bell.wav;\n:月台上響起了鈴聲。;']
    ] as const) {
      const edit = run(snapshot(text), { mode: 'draft', firstLine: index + 1, before: lines[index], after });
      const expected = lines.with(index, after).join('\n');
      expect(edit.afterRevision).toBe(snapshot(expected).revision);
      const reverse = run(snapshot(expected), { mode: 'undo', receipt: edit.receipt });
      expect(reverse.afterRevision).toBe(snapshot(text).revision);
    }
  });

  it('refuses an approved-shape plan if a manual save changes its target before MCP apply', async () => {
    const base = await realpath(await mkdtemp(path.join(tmpdir(), 'editor-stale-')));
    const root = path.join(base, 'game-project');
    const target = path.join(root, 'game/scene/station.txt');
    const server = createServer({ version: 1, projects: [{ id: projectId, root }], sources: [] }, {
      stateRoot: path.join(base, 'state'), coordinatorOptions: {
        locks: new ProjectLocks(path.join(base, 'locks')), capabilityCheck: async () => true
      }
    });
    const client = new Client({ name: 'editor-test', version: '1' });
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    async function call(name: string, args: Record<string, unknown>) {
      const result = await client.callTool({ name, arguments: args });
      const data = JSON.parse((result.content as { text: string }[])[0]!.text);
      return { data, error: result.isError === true };
    }
    try {
      await mkdir(path.dirname(target), { recursive: true });
      await mkdir(path.join(root, 'game/bgm'));
      await writeFile(path.join(root, 'game/bgm/station.mp3'), 'test metadata only');
      await writeFile(path.join(root, 'game/config.txt'), 'Game_name:Station;\n');
      await writeFile(target, '\ufeff' + original);
      await server.connect(serverSide);
      await client.connect(clientSide);
      const saved = await call('scene_read', { projectId, path: 'station.txt' });
      const { operation } = stationEdit(saved.data);
      const draft = await call('change_plan', { projectId, operations: [operation] });
      expect(draft.error).toBe(false);
      const session = await call('write_session_begin', { projectId, paths: ['game/scene/station.txt'],
        decision: 'saved-and-editors-closed', statement: 'Synthetic handoff for a temporary test fixture.' });
      expect(session.error).toBe(false);
      const sessionId = session.data.sessionId;
      const formal = await call('change_plan', { projectId, sessionId, operations: [operation] });
      expect(formal.error).toBe(false);
      const manual = '\ufeff' + original.slice(0, original.lastIndexOf(dialogue)) + '小澪:手改;\r\n:車來了。;';
      await writeFile(target, manual);
      const applied = await call('change_apply', { sessionId, planId: formal.data.planId, idempotencyKey: 'stale-test' });
      expect(applied.error).toBe(true);
      expect(JSON.stringify(applied.data)).toContain('REVISION_CONFLICT');
      expect(await readFile(target, 'utf8')).toBe(manual);
    } finally {
      await client.close();
      await server.close();
      await rm(base, { recursive: true, force: true, maxRetries: 3 });
    }
  });
});
