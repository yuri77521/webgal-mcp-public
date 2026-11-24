import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { discoverLive2dModels } from '../src/live2d/discover.js';
import {
  inspectLive2dModel,
  listLive2dModelEntries,
  snapshotLive2dCatalog,
} from '../src/live2d/model.js';
import { createLive2dSceneCheck } from '../src/live2d/scene.js';
import { ReadService } from '../src/service.js';
import type { AppConfig } from '../src/types.js';

let temporary: string;
let projectRoot: string;
let sourceRoot: string;
let config: AppConfig;

async function put(root: string, relative: string, contents: string | Buffer = relative) {
  const target = join(root, relative);
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, contents);
  return target;
}

async function cubism2Source() {
  await put(sourceRoot, 'characters/sakiko/school/model.json', JSON.stringify({
    version: 'Sample 1.0.0',
    layout: {},
    hit_areas_custom: {},
    model: '.chara/model.moc',
    physics: '.chara/physics.json',
    textures: ['.chara/texture_00.png', '.chara/texture_01.png'],
    motions: {
      'sakiko/idle01': { file: '../.mtn_exp/motions/PARAM_IMPORT__50/sakiko/idle01.mtn' },
      'sakiko/bow': { file: '../.mtn_exp/motions/PARAM_IMPORT__50/sakiko/bow.mtn' },
    },
    expressions: [
      {
        name: 'sakiko/cry01',
        file: '../.mtn_exp/expressions/__base__/sakiko/cry01.exp.json',
      },
    ],
  }));
  await Promise.all([
    put(sourceRoot, 'characters/sakiko/school/.chara/model.moc', 'moc'),
    put(sourceRoot, 'characters/sakiko/school/.chara/physics.json', '{}'),
    put(sourceRoot, 'characters/sakiko/school/.chara/texture_00.png', 'png'),
    put(sourceRoot, 'characters/sakiko/school/.chara/texture_01.png', 'png'),
    put(
      sourceRoot,
      'characters/sakiko/.mtn_exp/motions/PARAM_IMPORT__50/sakiko/idle01.mtn',
      '{"idle":1}',
    ),
    put(
      sourceRoot,
      'characters/sakiko/.mtn_exp/motions/PARAM_IMPORT__50/sakiko/bow.mtn',
      '{"bow":1}',
    ),
    put(
      sourceRoot,
      'characters/sakiko/.mtn_exp/expressions/__base__/sakiko/cry01.exp.json',
      '{"cry":1}',
    ),
  ]);
}

async function cubism3Source() {
  await put(sourceRoot, 'Haru/runtime/haru.model3.json', JSON.stringify({
    Version: 3,
    FileReferences: {
      Moc: 'haru.moc3',
      Textures: ['haru.2048/texture_00.png'],
      Physics: 'haru.physics3.json',
      Motions: {
        Idle: [{ File: 'motion/idle.motion3.json' }],
        Tap: [
          { File: 'motion/tap-0.motion3.json' },
          { File: 'motion/tap-1.motion3.json', Sound: 'sounds/tap-1.wav' },
        ],
      },
    },
  }));
  await Promise.all([
    put(sourceRoot, 'Haru/runtime/haru.moc3', 'moc3'),
    put(sourceRoot, 'Haru/runtime/haru.2048/texture_00.png', 'png'),
    put(sourceRoot, 'Haru/runtime/haru.physics3.json', '{}'),
    put(sourceRoot, 'Haru/runtime/motion/idle.motion3.json', '{}'),
    put(sourceRoot, 'Haru/runtime/motion/tap-0.motion3.json', '{}'),
    put(sourceRoot, 'Haru/runtime/motion/tap-1.motion3.json', '{}'),
    put(sourceRoot, 'Haru/runtime/sounds/tap-1.wav', 'wav'),
    put(sourceRoot, 'Haru/runtime/expressions/Smile.exp3.json', '{}'),
  ]);
}

beforeEach(async () => {
  temporary = await realpath(await mkdtemp(join(tmpdir(), 'webgal-live2d-library-')));
  projectRoot = join(temporary, 'project');
  sourceRoot = join(temporary, 'source');
  await mkdir(projectRoot);
  await mkdir(sourceRoot);
  await put(projectRoot, 'game/scene/start.txt', 'Start;');
  config = {
    version: 1,
    projects: [{ id: 'test', root: projectRoot }],
    sources: [{ id: 'models', root: sourceRoot }],
  };
});

afterEach(async () => {
  await rm(temporary, { recursive: true, force: true });
});

describe('Live2D model library read side', () => {
  it('inspects Cubism 2 dependencies across package siblings', async () => {
    await cubism2Source();
    const report = await inspectLive2dModel(config, {
      kind: 'source',
      sourceId: 'models',
      modelPath: 'characters/sakiko/school/model.json',
      rootPath: 'characters/sakiko',
    });

    expect(report).toMatchObject({
      status: 'valid',
      format: 'cubism2',
      modelPath: 'characters/sakiko/school/model.json',
      rootPath: 'characters/sakiko',
      issues: [],
      counts: {
        dependencies: 7,
        presentDependencies: 7,
        motionGroups: 2,
        motionFiles: 2,
        registeredExpressions: 1,
        unregisteredExpressions: 0,
      },
    });
    expect(report.dependencies).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: 'motion',
        path: '../.mtn_exp/motions/PARAM_IMPORT__50/sakiko/bow.mtn',
        status: 'present',
      }),
    ]));
  });

  it('confines parent references unless the package root is explicit', async () => {
    await cubism2Source();
    const closed = await inspectLive2dModel(config, {
      kind: 'source',
      sourceId: 'models',
      modelPath: 'characters/sakiko/school/model.json',
    });
    expect(closed).toMatchObject({
      status: 'invalid',
      rootPath: 'characters/sakiko/school',
    });
    expect(closed.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'DEPENDENCY_PATH_INVALID', status: 'invalid' }),
    ]));
    expect(closed.dependencies).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ path: expect.stringContaining('../.mtn_exp/') }),
    ]));
  });

  it('normalizes omitted rootPath for root-level and nested model entries', async () => {
    const model = (physics?: string) => JSON.stringify({
      version: 'Sample 1.0.0',
      model: 'model.moc',
      ...(physics ? { physics } : {}),
      textures: ['texture.png'],
      motions: {},
      expressions: [],
    });
    await Promise.all([
      put(sourceRoot, 'model.json', model()),
      put(sourceRoot, 'model.moc', 'moc'),
      put(sourceRoot, 'texture.png', 'png'),
      put(sourceRoot, 'H/model.json', model('../outside.physics.json')),
      put(sourceRoot, 'H/model.moc', 'moc'),
      put(sourceRoot, 'H/texture.png', 'png'),
      put(sourceRoot, 'outside.physics.json', '{}'),
    ]);

    const rootModel = await inspectLive2dModel(config, {
      kind: 'source',
      sourceId: 'models',
      modelPath: 'model.json',
    });
    expect(rootModel).toMatchObject({
      status: 'valid',
      rootPath: '',
    });

    const nestedModel = await inspectLive2dModel(config, {
      kind: 'source',
      sourceId: 'models',
      modelPath: 'H/model.json',
    });
    expect(nestedModel).toMatchObject({
      status: 'invalid',
      rootPath: 'H',
    });
    expect(nestedModel.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({
        code: 'DEPENDENCY_PATH_INVALID',
        status: 'invalid',
        field: 'physics',
      }),
    ]));
    expect(nestedModel.dependencies).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ path: '../outside.physics.json' }),
    ]));
  });

  it('pages same-name motion and expression entries with file fingerprints', async () => {
    await cubism2Source();
    const location = {
      kind: 'source' as const,
      sourceId: 'models',
      modelPath: 'characters/sakiko/school/model.json',
      rootPath: 'characters/sakiko',
    };
    const motions = await listLive2dModelEntries(
      config,
      location,
      { kind: 'motion', prefix: 'sakiko/', offset: 1, limit: 1 },
    );
    expect(motions).toMatchObject({
      total: 2,
      offset: 1,
      limit: 1,
      nextOffset: null,
    });
    expect(motions.items[0]).toMatchObject({
      kind: 'motion',
      name: 'sakiko/bow',
      motionGroup: 'sakiko/bow',
      motionIndex: 0,
      status: 'present',
      fingerprint: expect.stringMatching(/^[a-f0-9]{64}$/),
    });

    const expressions = await listLive2dModelEntries(
      config,
      location,
      { kind: 'expression', prefix: 'sakiko/cry' },
    );
    expect(expressions.items).toEqual([
      expect.objectContaining({
        name: 'sakiko/cry01',
        status: 'registered',
        fingerprint: expect.stringMatching(/^[a-f0-9]{64}$/),
      }),
    ]);
  });

  it('reports a missing declared expression file on the expression itself', async () => {
    await cubism2Source();
    await rm(join(sourceRoot, 'characters/sakiko/.mtn_exp/expressions/__base__/sakiko/cry01.exp.json'));
    const page = await listLive2dModelEntries(config, {
      kind: 'source', sourceId: 'models', modelPath: 'characters/sakiko/school/model.json',
      rootPath: 'characters/sakiko',
    }, { kind: 'expression' });
    expect(page.items[0]).toMatchObject({ name: 'sakiko/cry01', status: 'missing', fingerprint: null });
  });

  it('changes action fingerprints when manifest revision stays unchanged', async () => {
    await cubism2Source();
    const location = {
      kind: 'source' as const,
      sourceId: 'models',
      modelPath: 'characters/sakiko/school/model.json',
      rootPath: 'characters/sakiko',
    };
    const before = await snapshotLive2dCatalog(config, location);
    const beforeBow = before.items.find(item => item.name === 'sakiko/bow');
    expect(beforeBow?.fingerprint).toMatch(/^[a-f0-9]{64}$/);

    await put(
      sourceRoot,
      'characters/sakiko/.mtn_exp/motions/PARAM_IMPORT__50/sakiko/bow.mtn',
      '{"bow":2}',
    );
    const after = await snapshotLive2dCatalog(config, location);
    const afterBow = after.items.find(item => item.name === 'sakiko/bow');
    expect(after.report.revision).toBe(before.report.revision);
    expect(afterBow?.fingerprint).not.toBe(beforeBow?.fingerprint);
  });

  it('reports Haru unregistered expressions and motion group members', async () => {
    await cubism3Source();
    const location = {
      kind: 'source' as const,
      sourceId: 'models',
      modelPath: 'Haru/runtime/haru.model3.json',
      rootPath: 'Haru',
    };
    const snapshot = await snapshotLive2dCatalog(config, location);
    expect(snapshot.report).toMatchObject({
      status: 'valid',
      format: 'cubism3',
      counts: {
        motionGroups: 2,
        motionFiles: 3,
        registeredExpressions: 0,
        unregisteredExpressions: 1,
      },
    });
    expect(snapshot.report.unregisteredExpressions).toEqual([
      { name: 'Smile', file: 'expressions/Smile.exp3.json' },
    ]);
    expect(snapshot.items.filter(item => item.kind === 'motion' && item.name === 'Tap')).toEqual([
      expect.objectContaining({ motionIndex: 0 }),
      expect.objectContaining({
        motionIndex: 1,
        sound: 'sounds/tap-1.wav',
        fingerprint: expect.stringMatching(/^[a-f0-9]{64}$/),
      }),
    ]);
    expect(snapshot.items.find(item => (
      item.kind === 'motion' && item.name === 'Tap' && item.motionIndex === 0
    ))).not.toHaveProperty('sound');
    const smile = snapshot.items.find(item => (
      item.kind === 'expression' && item.name === 'Smile'
    ));
    expect(smile).toMatchObject({
      status: 'unregistered',
      fingerprint: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
  });

  it('discovers sorted valid and broken model candidates within one package', async () => {
    await cubism2Source();
    await put(sourceRoot, 'characters/sakiko/.mtn_exp/model.json', JSON.stringify({
      version: 'Sample 1.0.0',
      model: '.chara/model.moc',
      textures: ['.chara/texture_00.png', '.chara/texture_01.png'],
      motions: {},
      expressions: [],
    }));
    await put(sourceRoot, 'characters/sakiko/school/other-character.model.json', JSON.stringify({
      version: 'Sample 1.0.0',
      model: '.chara/model.moc',
      physics: '.chara/physics.json',
      textures: ['.chara/texture_00.png'],
      motions: {
        'sakiko/bow': { file: '../.mtn_exp/motions/PARAM_IMPORT__50/sakiko/bow.mtn' },
      },
      expressions: [],
    }));
    await put(sourceRoot, 'characters/sakiko/school/not-a-model.json', JSON.stringify({
      name: 'annotation only',
    }));

    const page = await discoverLive2dModels(config, {
      location: { kind: 'source', sourceId: 'models' },
      directory: 'characters/sakiko',
      limit: 1,
    });
    expect(page).toMatchObject({ total: 3, offset: 0, limit: 1, nextOffset: 1 });
    expect(page.items[0]).toMatchObject({
      modelPath: 'characters/sakiko/.mtn_exp/model.json',
      rootPath: 'characters/sakiko',
      format: 'cubism2',
      status: 'invalid',
      missingFiles: expect.arrayContaining([
        '.chara/model.moc',
        '.chara/texture_00.png',
        '.chara/texture_01.png',
      ]),
    });
    const next = await discoverLive2dModels(config, {
      location: { kind: 'source', sourceId: 'models' },
      directory: 'characters/sakiko',
      offset: page.nextOffset!,
      limit: 1,
    });
    expect(next.items[0]).toMatchObject({
      modelPath: 'characters/sakiko/school/model.json',
      status: 'valid',
    });
    const generic = await discoverLive2dModels(config, {
      location: { kind: 'source', sourceId: 'models' },
      directory: 'characters/sakiko',
      offset: 2,
      limit: 1,
    });
    expect(generic.items[0]).toMatchObject({
      modelPath: 'characters/sakiko/school/other-character.model.json',
      status: 'valid',
    });
  });

  it('validates Cubism 2 selectors and distinguishes unregistered expressions', async () => {
    await cubism2Source();
    const c2Model = await put(
      projectRoot,
      'game/figure/sakiko/school/model.json',
      JSON.stringify({
        version: 'Sample 1.0.0',
        layout: {},
        hit_areas_custom: {},
        model: '.chara/model.moc',
        textures: ['.chara/texture_00.png'],
        motions: {
          'sakiko/bow': { file: '.mtn_exp/bow.mtn' },
        },
        expressions: [
          { name: 'sakiko/cry01', file: '.mtn_exp/cry01.exp.json' },
        ],
      }),
    );
    expect(c2Model).toContain('game');
    await Promise.all([
      put(projectRoot, 'game/figure/sakiko/school/.chara/model.moc', 'moc'),
      put(projectRoot, 'game/figure/sakiko/school/.chara/texture_00.png', 'png'),
      put(projectRoot, 'game/figure/sakiko/school/.mtn_exp/bow.mtn', '{"bow":1}'),
      put(projectRoot, 'game/figure/sakiko/school/.mtn_exp/cry01.exp.json', '{"cry":1}'),
    ]);
    await cubism3Source();
    await put(projectRoot, 'game/figure/Haru/runtime/haru.model3.json', JSON.stringify({
      Version: 3,
      FileReferences: {
        Moc: 'haru.moc3',
        Textures: ['texture.png'],
      },
    }));
    await Promise.all([
      put(projectRoot, 'game/figure/Haru/runtime/haru.moc3', 'moc3'),
      put(projectRoot, 'game/figure/Haru/runtime/texture.png', 'png'),
      put(projectRoot, 'game/figure/Haru/runtime/expressions/Smile.exp3.json', '{}'),
    ]);

    const scene = [
      'changeFigure:sakiko/school/model.json -motion=sakiko/bow -expression=sakiko/cry01;',
      'changeFigure:sakiko/school/model.json -motion=missing -expression=missing;',
      'changeFigure:Haru/runtime/haru.model3.json -expression=Smile;',
    ].join('\n');
    const result = await new ReadService(config).validate('test', 'start.txt', scene);
    expect(result.live2dIssues).toEqual(expect.arrayContaining([
      expect.objectContaining({ line: 2, selector: 'motion', code: 'UNKNOWN_MOTION_GROUP' }),
      expect.objectContaining({ line: 2, selector: 'expression', code: 'UNKNOWN_EXPRESSION' }),
      expect.objectContaining({ line: 3, selector: 'expression', code: 'UNREGISTERED_EXPRESSION' }),
    ]));
    expect(result.live2dIssues.some(issue => issue.line === 1)).toBe(false);
  });

  it('checks large model selector sets without using truncated response lists', async () => {
    const motionGroups = Object.fromEntries(Array.from(
      { length: 300 },
      (_, index) => [`group-${index}`, [{ File: 'motion/shared.motion3.json' }]],
    ));
    const expressions = Array.from(
      { length: 300 },
      (_, index) => ({ Name: `expression-${index}`, File: 'expressions/shared.exp3.json' }),
    );
    await put(projectRoot, 'game/figure/large/large.model3.json', JSON.stringify({
      Version: 3,
      FileReferences: {
        Moc: 'large.moc3',
        Textures: ['texture.png'],
        Motions: motionGroups,
        Expressions: expressions,
      },
    }));
    await Promise.all([
      put(projectRoot, 'game/figure/large/large.moc3', 'moc3'),
      put(projectRoot, 'game/figure/large/texture.png', 'png'),
      put(projectRoot, 'game/figure/large/motion/shared.motion3.json', '{}'),
      put(projectRoot, 'game/figure/large/expressions/shared.exp3.json', '{}'),
    ]);
    const report = await inspectLive2dModel(config, {
      kind: 'project',
      projectId: 'test',
      modelPath: 'large/large.model3.json',
      rootPath: 'large',
    });
    expect(report).toMatchObject({
      status: 'valid',
      counts: {
        motionGroups: 300,
        registeredExpressions: 300,
      },
    });
    expect(report.motions).toHaveLength(256);
    expect(report.expressions).toHaveLength(256);

    const scene = [
      'changeFigure:large/large.model3.json -motion=group-299 -expression=expression-299;',
      'changeFigure:large/large.model3.json -motion=group-300 -expression=expression-300;',
    ].join('\n');

    const result = await new ReadService(config).validate('test', 'start.txt', scene);
    expect(result.live2dIssues).toEqual(expect.arrayContaining([
      expect.objectContaining({
        line: 2,
        selector: 'motion',
        code: 'UNKNOWN_MOTION_GROUP',
        name: 'group-300',
      }),
      expect.objectContaining({
        line: 2,
        selector: 'expression',
        code: 'UNKNOWN_EXPRESSION',
        name: 'expression-300',
      }),
    ]));
    expect(result.live2dIssues.some(issue => issue.line === 1)).toBe(false);
  });

  it('rejects pages collected from a changed model entry', async () => {
    await cubism3Source();
    const location = {
      kind: 'source' as const,
      sourceId: 'models',
      modelPath: 'Haru/runtime/haru.model3.json',
      rootPath: 'Haru',
    };
    const first = await listLive2dModelEntries(config, location, { limit: 1 });
    expect(first.revision).toMatch(/^[a-f0-9]{64}$/);
    await put(
      sourceRoot,
      'Haru/runtime/haru.model3.json',
      `${JSON.stringify({
        Version: 3,
        FileReferences: {
          Moc: 'haru.moc3',
          Textures: ['haru.2048/texture_00.png'],
        },
      })}\n`,
    );
    await expect(listLive2dModelEntries(config, location, {
      offset: 1,
      expectedRevision: first.revision!,
    })).rejects.toMatchObject({ code: 'SOURCE_CHANGED' });
  });
});
