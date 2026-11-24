import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { WriteCoordinator, type CoordinatorOptions } from '../src/changes/coordinator.js';
import { ProjectLocks } from '../src/changes/locks.js';
import type { WritePlan } from '../src/changes/types.js';
import { discoverLive2dModels } from '../src/live2d/discover.js';
import { planLive2dImport } from '../src/live2d/import.js';
import type { AppConfig } from '../src/types.js';

const owner = 'live2d-incremental-test';
const statement = {
  source: 'user-message' as const,
  statement: 'Saved and closed the temporary Live2D editor.',
};

let temporary: string;
let projectRoot: string;
let sourceRoot: string;
let stateRoot: string;
let lockRoot: string;
let config: AppConfig;

async function put(root: string, relative: string, contents: string | Buffer = relative) {
  const target = join(root, relative);
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, contents);
  return target;
}

function coordinator(fault?: CoordinatorOptions['fault']) {
  return WriteCoordinator.create(config, stateRoot, {
    locks: new ProjectLocks(lockRoot),
    capabilityCheck: async () => true,
    fault,
  });
}

function draft(input: Parameters<typeof planLive2dImport>[1]) {
  return planLive2dImport(config, { mode: 'curated', ...input }, async () => {
    throw new Error('A draft must not persist a plan.');
  });
}

async function planned(host: WriteCoordinator, input: Parameters<typeof planLive2dImport>[1]) {
  const review = await draft(input);
  expect(review.blockingIssues).toEqual([]);
  const session = host.sessions.begin(owner, input.projectId, statement, review.paths);
  let writePlan: WritePlan | undefined;
  const plan = await planLive2dImport(config, {
    mode: 'curated',
    ...input,
    sessionId: session.id,
    expectedBundleRevision: review.bundleRevision!,
  }, async (sessionId, files, bundle) => {
    writePlan = await host.plan(owner, sessionId, input.projectId, files, undefined, undefined, bundle);
    return writePlan;
  });
  expect(plan).toMatchObject({ committable: true, blockingIssues: [] });
  return { review, session, plan, writePlan: writePlan! };
}

async function putSakikoSource() {
  await put(sourceRoot, 'characters/sakiko/school/model.json', JSON.stringify({
    version: 'Sample 1.0.0',
    layout: {},
    hit_areas_custom: {},
    model: '.chara/model.moc',
    physics: '.chara/physics.json',
    textures: ['.chara/texture_00.png'],
    motions: {
      'sakiko/bow': [{
        file: '../.mtn_exp/motions/PARAM_IMPORT__50/sakiko/bow.mtn',
        FadeInTime: 0.35,
        FadeOutTime: 1.25,
        Loop: false,
      }],
    },
    expressions: [{ name: 'sakiko/cry01', file: '../.mtn_exp/expressions/__base__/sakiko/cry01.exp.json' }],
  }));
  await Promise.all([
    put(sourceRoot, 'characters/sakiko/school/.chara/model.moc', 'moc'),
    put(sourceRoot, 'characters/sakiko/school/.chara/physics.json', '{}'),
    put(sourceRoot, 'characters/sakiko/school/.chara/texture_00.png', 'png'),
    put(sourceRoot, 'characters/sakiko/.mtn_exp/motions/PARAM_IMPORT__50/sakiko/bow.mtn', 'motion'),
    put(sourceRoot, 'characters/sakiko/.mtn_exp/expressions/__base__/sakiko/cry01.exp.json', '{"params":[]}'),
    put(sourceRoot, 'characters/sakiko/school/expressions/smile01.exp.json', '{"params":[1]}'),
  ]);
}

async function putBatchSource(textureCount = 34) {
  const textures = Array.from({ length: textureCount }, (_, index) => `textures/texture_${index}.png`);
  await put(sourceRoot, 'batch/model.json', JSON.stringify({
    version: 'Sample 1.0.0',
    layout: {},
    hit_areas_custom: {},
    model: 'model.moc',
    textures,
    motions: {},
    expressions: [],
  }));
  await Promise.all([
    put(sourceRoot, 'batch/model.moc', 'moc'),
    ...textures.map(path => put(sourceRoot, `batch/${path}`, path)),
  ]);
}

async function putDependencyOnlyUpdate() {
  const sourceManifest = {
    version: 'Sample 1.0.0',
    layout: {},
    hit_areas_custom: {},
    model: 'model.moc',
    textures: ['existing.png', 'missing.png'],
    motions: {},
    expressions: [],
  };
  const targetManifest = {
    ...sourceManifest,
    motions: { 'old/keep': [{ file: 'old.mtn' }] },
  };
  await put(sourceRoot, 'dependency-only/model.json', JSON.stringify(sourceManifest));
  await put(sourceRoot, 'dependency-only/model.moc', 'moc');
  await put(sourceRoot, 'dependency-only/existing.png', 'existing');
  await put(sourceRoot, 'dependency-only/missing.png', 'missing');
  await put(projectRoot, 'game/figure/dependency-only/model.json', JSON.stringify(targetManifest));
  await put(projectRoot, 'game/figure/dependency-only/model.moc', 'moc');
  await put(projectRoot, 'game/figure/dependency-only/existing.png', 'existing');
  await put(projectRoot, 'game/figure/dependency-only/old.mtn', 'old motion');
  return {
    sourceManifest,
    targetManifest,
    input: {
      projectId: 'test',
      sourceId: 'models',
      modelPath: 'dependency-only/model.json',
      rootPath: 'dependency-only',
      targetDirectory: 'dependency-only',
    },
  };
}

function revision(contents: string | Buffer) {
  return createHash('sha256').update(contents).digest('hex');
}

const sakikoInput = {
  projectId: 'test',
  sourceId: 'models',
  modelPath: 'characters/sakiko/school/model.json',
  rootPath: 'characters/sakiko',
  targetDirectory: 'sakiko',
  motions: [{ name: 'sakiko/bow' }],
};

beforeEach(async () => {
  temporary = await realpath(await mkdtemp(join(tmpdir(), 'webgal-live2d-incremental-')));
  projectRoot = join(temporary, 'project');
  sourceRoot = join(temporary, 'source');
  stateRoot = join(temporary, 'state');
  lockRoot = join(temporary, 'locks');
  await mkdir(projectRoot);
  await mkdir(sourceRoot);
  await put(projectRoot, 'game/scene/start.txt', 'Start;');
  await mkdir(join(projectRoot, 'game/figure'), { recursive: true });
  config = {
    version: 1,
    projects: [{ id: 'test', root: projectRoot }],
    sources: [{ id: 'models', root: sourceRoot }],
  };
});

afterEach(async () => {
  await rm(temporary, { recursive: true, force: true });
});

it('reviews a first curated import and preserves complete motion member options', async () => {
  await putSakikoSource();
  const host = await coordinator();
  const input = {
    ...sakikoInput,
    expressions: [{ name: 'sakiko/cry01' }],
  };
  const { review } = await planned(host, input);

  expect(review).toMatchObject({
    mode: 'curated',
    modelTargetPath: 'game/figure/sakiko/school/model.json',
    blockingIssues: [],
    gameEntry: {
      action: 'create',
      path: 'game/figure/sakiko/school/model.json',
      revisions: { before: null, after: expect.stringMatching(/^[a-f0-9]{64}$/) },
      motions: [{
        targetGroup: 'sakiko/bow',
        targetMemberIndex: 0,
        action: 'add',
        value: {
          file: '../_mtn_exp/motions/PARAM_IMPORT__50/sakiko/bow.mtn',
          FadeInTime: 0.35,
          FadeOutTime: 1.25,
          Loop: false,
        },
      }],
      expressions: [{
        name: 'sakiko/cry01',
        action: 'add',
        value: {
          name: 'sakiko/cry01',
          file: '../_mtn_exp/expressions/__base__/sakiko/cry01.exp.json',
        },
      }],
    },
  });
  expect(review.paths).toEqual(expect.arrayContaining([
    'game/figure/sakiko/school/_chara/model.moc',
    'game/figure/sakiko/_mtn_exp/motions/PARAM_IMPORT__50/sakiko/bow.mtn',
    'game/figure/sakiko/_mtn_exp/expressions/__base__/sakiko/cry01.exp.json',
  ]));
  expect(review.gameEntry?.references).toEqual(expect.arrayContaining([
    expect.objectContaining({ kind: 'moc', path: '_chara/model.moc', action: 'add' }),
    expect.objectContaining({
      kind: 'motion',
      path: '../_mtn_exp/motions/PARAM_IMPORT__50/sakiko/bow.mtn',
      action: 'add',
    }),
    expect.objectContaining({
      kind: 'expression',
      path: '../_mtn_exp/expressions/__base__/sakiko/cry01.exp.json',
      action: 'add',
    }),
  ]));
  await expect(draft({ ...input, extraPaths: ['script.js'] }))
    .rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
});

it('normalizes a discovered custom JSON entry to model.json during curated import', async () => {
  await put(sourceRoot, 'custom/sakiko.json', JSON.stringify({
    version: 'Sample 1.0.0',
    layout: {},
    hit_areas_custom: {},
    model: '.chara/model.moc',
    textures: ['.chara/texture_00.png'],
    motions: {},
    expressions: [],
  }));
  await put(sourceRoot, 'custom/.chara/model.moc', 'moc');
  await put(sourceRoot, 'custom/.chara/texture_00.png', 'png');

  const discovered = await discoverLive2dModels(config, {
    location: { kind: 'source', sourceId: 'models' },
  });
  expect(discovered.items).toEqual(expect.arrayContaining([
    expect.objectContaining({ modelPath: 'custom/sakiko.json', format: 'cubism2' }),
  ]));

  const host = await coordinator();
  const imported = await planned(host, {
    projectId: 'test',
    sourceId: 'models',
    modelPath: 'custom/sakiko.json',
    rootPath: 'custom',
    targetDirectory: 'custom-model',
  });
  expect(imported.review).toMatchObject({
    blockingIssues: [],
    modelTargetPath: 'game/figure/custom-model/model.json',
    gameEntry: {
      action: 'create',
      path: 'game/figure/custom-model/model.json',
    },
  });
  const applied = await host.apply(
    owner,
    imported.session.id,
    imported.plan.planId!,
    'custom-model-entry',
  );
  expect(applied).toMatchObject({ status: 'complete' });
  expect(await host.inspect('test', applied.batchId)).toMatchObject({
    status: 'complete',
    modelBundle: { modelPath: 'game/figure/custom-model/model.json' },
  });
  expect(JSON.parse(await readFile(
    join(projectRoot, 'game/figure/custom-model/model.json'),
    'utf8',
  ))).toMatchObject({
    model: '_chara/model.moc',
    textures: ['_chara/texture_00.png'],
  });
  await expect(readFile(join(projectRoot, 'game/figure/custom-model/sakiko.json')))
    .rejects.toMatchObject({ code: 'ENOENT' });
});

it('reviews an incremental unregistered expression without dropping existing motion options', async () => {
  await putSakikoSource();
  const host = await coordinator();
  const first = await planned(host, {
    ...sakikoInput,
    expressions: [{ name: 'sakiko/cry01' }],
  });
  expect(await host.apply(owner, first.session.id, first.plan.planId!, 'initial-curated'))
    .toMatchObject({ status: 'complete' });

  const secondInput = {
    ...sakikoInput,
    expressions: [{ name: 'smile01' }],
  };
  const secondDraft = await draft(secondInput);
  expect(secondDraft).toMatchObject({
    blockingIssues: [],
    gameEntry: {
      action: 'update',
      revisions: {
        before: first.review.gameEntry?.revisions.after,
        after: expect.stringMatching(/^[a-f0-9]{64}$/),
      },
      motions: [{ targetGroup: 'sakiko/bow', action: 'unchanged' }],
      expressions: [{
        name: 'smile01',
        previouslyUnregistered: true,
        action: 'add',
        value: { name: 'smile01', file: 'expressions/smile01.exp.json' },
      }],
    },
  });
  expect(secondDraft.gameEntry?.references).toEqual(expect.arrayContaining([
    expect.objectContaining({
      kind: 'expression',
      path: 'expressions/smile01.exp.json',
      action: 'add',
    }),
  ]));

  const session = host.sessions.begin(owner, 'test', statement, secondDraft.paths);
  const secondPlan = await planLive2dImport(config, {
    mode: 'curated',
    ...secondInput,
    sessionId: session.id,
    expectedBundleRevision: secondDraft.bundleRevision!,
  }, (sessionId, files, bundle) => (
    host.plan(owner, sessionId, 'test', files, undefined, undefined, bundle)
  ));
  expect(secondPlan.blockingIssues).toEqual([]);
  expect(await host.apply(owner, session.id, secondPlan.planId!, 'incremental-expression'))
    .toMatchObject({ status: 'complete' });

  const manifest = JSON.parse(await readFile(
    join(projectRoot, 'game/figure/sakiko/school/model.json'),
    'utf8',
  ));
  expect(manifest.motions['sakiko/bow'][0]).toEqual({
    file: '../_mtn_exp/motions/PARAM_IMPORT__50/sakiko/bow.mtn',
    FadeInTime: 0.35,
    FadeOutTime: 1.25,
    Loop: false,
  });
  expect(manifest.expressions).toContainEqual({
    name: 'smile01',
    file: 'expressions/smile01.exp.json',
  });
});

it('recovers complete and partial update batches with an empty directory journal', async () => {
  await putSakikoSource();
  const host = await coordinator();
  const initial = await planned(host, {
    ...sakikoInput,
    expressions: [{ name: 'sakiko/cry01' }],
  });
  expect(await host.apply(owner, initial.session.id, initial.plan.planId!, 'update-recovery-initial'))
    .toMatchObject({ status: 'complete' });

  await put(sourceRoot, 'characters/sakiko/school/recovery.png', 'recovery');
  const completeInput = {
    ...sakikoInput,
    expressions: [{ name: 'sakiko/cry01' }],
    extraPaths: ['recovery.png'],
  };
  const complete = await planned(host, completeInput);
  const completeResult = await host.apply(
    owner,
    complete.session.id,
    complete.plan.planId!,
    'update-recovery-complete',
  );
  expect(completeResult).toMatchObject({ status: 'complete' });
  expect(await host.inspect('test', completeResult.batchId)).toMatchObject({
    status: 'complete',
    modelBundle: { mode: 'update' },
    directories: [],
  });
  expect(await host.apply(
    owner,
    complete.session.id,
    complete.plan.planId!,
    'update-recovery-complete',
  )).toMatchObject({ batchId: completeResult.batchId, status: 'complete', replayed: true });

  await put(sourceRoot, 'characters/sakiko/school/partial.png', 'partial');
  const interruptionHost = await coordinator((point) => {
    if (point === 'before-complete') throw new Error('simulated update interruption');
  });
  const partial = await planned(interruptionHost, {
    ...sakikoInput,
    expressions: [{ name: 'sakiko/cry01' }],
    extraPaths: ['partial.png'],
  });
  const partialResult = await interruptionHost.apply(
    owner,
    partial.session.id,
    partial.plan.planId!,
    'update-recovery-partial',
  );
  expect(partialResult).toMatchObject({ status: 'partial', errorCode: 'WRITE_FAILED' });

  const recoveryHost = await coordinator();
  expect(await recoveryHost.inspect('test', partialResult.batchId)).toMatchObject({
    status: 'partial',
    modelBundle: { mode: 'update' },
    directories: [],
  });
  expect(await interruptionHost.apply(
    owner,
    partial.session.id,
    partial.plan.planId!,
    'update-recovery-partial',
  )).toMatchObject({ batchId: partialResult.batchId, status: 'partial', replayed: true });
  await expect(interruptionHost.apply(
    owner,
    partial.session.id,
    partial.plan.planId!,
    'update-recovery-new-key',
  )).rejects.toMatchObject({ code: 'HANDOFF_REQUIRED' });
  expect(await recoveryHost.pending('test')).toMatchObject({
    unreadableRecords: 0,
    batches: expect.arrayContaining([
      expect.objectContaining({ batchId: partialResult.batchId, status: 'partial' }),
    ]),
  });
});

it('keeps a stable reviewed revision and resumes after an intermediate dependency batch failure', async () => {
  await putBatchSource();
  const input = {
    projectId: 'test',
    sourceId: 'models',
    modelPath: 'batch/model.json',
    rootPath: 'batch',
    targetDirectory: 'batch',
  };
  const interruptionHost = await coordinator((point) => {
    if (point === 'before-complete') throw new Error('simulated interruption');
  });
  const initial = await planned(interruptionHost, input);
  expect(initial.review).toMatchObject({
    batch: { index: 0, total: 2, entryIncluded: false, nextBatchIndex: 1 },
    gameEntry: { action: 'create' },
  });
  const failed = await interruptionHost.apply(
    owner,
    initial.session.id,
    initial.plan.planId!,
    'partial-dependency-batch',
  );
  expect(failed).toMatchObject({ status: 'partial', errorCode: 'WRITE_FAILED' });

  const retryDraft = await draft({
    ...input,
    batchIndex: 0,
    previousPlanId: initial.plan.planId!,
  });
  expect(retryDraft).toMatchObject({
    blockingIssues: [],
    bundleRevision: initial.review.bundleRevision,
    noOp: true,
    paths: [],
    batch: { index: 0, entryIncluded: false, total: 2, nextBatchIndex: 1 },
  });
  const nextDraft = await draft({
    ...input,
    batchIndex: 1,
    previousPlanId: initial.plan.planId!,
  });
  expect(nextDraft).toMatchObject({
    blockingIssues: [],
    bundleRevision: initial.review.bundleRevision,
    batch: { index: 1, entryIncluded: true, total: 2, nextBatchIndex: null },
  });
  const recoveryHost = await coordinator();
  const actualSession = recoveryHost.sessions.begin(owner, 'test', statement, nextDraft.paths);
  const retryPlan = await planLive2dImport(config, {
    mode: 'curated',
    ...input,
    batchIndex: 1,
    previousPlanId: initial.plan.planId!,
    sessionId: actualSession.id,
    expectedBundleRevision: nextDraft.bundleRevision!,
  }, (sessionId, files, bundle) => (
    recoveryHost.plan(owner, sessionId, 'test', files, undefined, undefined, bundle)
  ));
  expect(retryPlan.blockingIssues).toEqual([]);
  expect(retryPlan.committable).toBe(true);
  expect(await recoveryHost.apply(owner, actualSession.id, retryPlan.planId!, 'retry-dependency-batch'))
    .toMatchObject({ status: 'complete' });
  expect(JSON.parse(await readFile(join(projectRoot, 'game/figure/batch/model.json'), 'utf8')))
    .toMatchObject({ model: 'model.moc', textures: Array.from(
      { length: 34 },
      (_, index) => `textures/texture_${index}.png`,
    ) });
});

it('keeps nextBatchIndex stable after a non-final batch completes', async () => {
  await putBatchSource();
  const input = {
    projectId: 'test',
    sourceId: 'models',
    modelPath: 'batch/model.json',
    rootPath: 'batch',
    targetDirectory: 'batch-success',
  };
  const host = await coordinator();
  const first = await planned(host, input);
  expect(first.review).toMatchObject({
    batch: { index: 0, total: 2, entryIncluded: false, nextBatchIndex: 1 },
  });
  expect(await host.apply(owner, first.session.id, first.plan.planId!, 'successful-first-batch'))
    .toMatchObject({ status: 'complete' });

  const secondDraft = await draft({
    ...input,
    batchIndex: 1,
    previousPlanId: first.plan.planId!,
  });
  expect(secondDraft).toMatchObject({
    blockingIssues: [],
    bundleRevision: first.review.bundleRevision,
    batch: { index: 1, total: 2, entryIncluded: true, nextBatchIndex: null },
  });
  const secondSession = host.sessions.begin(owner, 'test', statement, secondDraft.paths);
  const secondPlan = await planLive2dImport(config, {
    mode: 'curated',
    ...input,
    batchIndex: 1,
    previousPlanId: first.plan.planId!,
    sessionId: secondSession.id,
    expectedBundleRevision: secondDraft.bundleRevision!,
  }, (sessionId, files, bundle) => (
    host.plan(owner, sessionId, 'test', files, undefined, undefined, bundle)
  ));
  expect(secondPlan.blockingIssues).toEqual([]);
  expect(await host.apply(owner, secondSession.id, secondPlan.planId!, 'successful-final-batch'))
    .toMatchObject({ status: 'complete' });
  expect(JSON.parse(await readFile(
    join(projectRoot, 'game/figure/batch-success/model.json'),
    'utf8',
  ))).toMatchObject({
    model: 'model.moc',
    textures: Array.from({ length: 34 }, (_, index) => `textures/texture_${index}.png`),
  });
});

it('skips already-satisfied dependency batches before an incremental update', async () => {
  const textureCount = 34;
  await putBatchSource(textureCount);
  const textures = Array.from(
    { length: textureCount },
    (_, index) => `textures/texture_${index}.png`,
  );
  const model = JSON.stringify({
    version: 'Sample 1.0.0',
    layout: {},
    hit_areas_custom: {},
    model: 'model.moc',
    textures,
    motions: {},
    expressions: [],
  });
  const targetRoot = 'game/figure/batch-update';
  await put(projectRoot, `${targetRoot}/model.json`, model);
  await put(projectRoot, `${targetRoot}/model.moc`, 'moc');
  await Promise.all(textures.map(path => put(projectRoot, `${targetRoot}/${path}`, path)));
  await put(sourceRoot, 'batch/zz-new.png', 'new texture');

  const input = {
    projectId: 'test',
    sourceId: 'models',
    modelPath: 'batch/model.json',
    rootPath: 'batch',
    targetDirectory: 'batch-update',
    extraPaths: ['zz-new.png'],
  };
  const review = await draft(input);
  expect(review).toMatchObject({
    blockingIssues: [],
    paths: ['game/figure/batch-update/zz-new.png'],
    noOp: false,
    batch: { index: 1, total: 2, entryIncluded: false, nextBatchIndex: null },
  });

  const explicitReview = await draft({ ...input, batchIndex: 1 });
  expect(explicitReview).toMatchObject({
    blockingIssues: [],
    paths: ['game/figure/batch-update/zz-new.png'],
    noOp: false,
    batch: { index: 1, total: 2, entryIncluded: false, nextBatchIndex: null },
  });

  const host = await coordinator();
  const session = host.sessions.begin(owner, 'test', statement, explicitReview.paths);
  let persistedPlan: WritePlan | undefined;
  const plan = await planLive2dImport(config, {
    mode: 'curated',
    ...input,
    batchIndex: 1,
    sessionId: session.id,
    expectedBundleRevision: explicitReview.bundleRevision!,
  }, async (sessionId, files, bundle) => {
    persistedPlan = await host.plan(owner, sessionId, 'test', files, undefined, undefined, bundle);
    return persistedPlan;
  });
  expect(plan.blockingIssues).toEqual([]);
  expect(persistedPlan?.modelBundle).toMatchObject({
    mode: 'update',
    batchIndex: 1,
    batchCount: 2,
    skippedBatchIndices: [0],
  });
});

it('revalidates prior-batch dependencies before publishing the model entry', async () => {
  const textures = ['textures/texture_0.png', 'textures/texture_1.png'];
  const targetManifest = {
    version: 'Sample 1.0.0',
    layout: {},
    hit_areas_custom: {},
    model: 'model.moc',
    textures,
    motions: {},
    expressions: [],
  };
  const sourceManifest = {
    ...targetManifest,
    motions: {
      'new/action': [{ file: 'new.mtn', FadeInTime: 0.4, FadeOutTime: 0.8 }],
    },
  };
  await put(sourceRoot, 'batch/model.json', JSON.stringify(sourceManifest));
  await put(sourceRoot, 'batch/model.moc', 'moc');
  await Promise.all(textures.map(path => put(sourceRoot, `batch/${path}`, path)));
  await put(sourceRoot, 'batch/new.mtn', 'motion');
  const extras = Array.from({ length: 32 }, (_, index) => `new-${String(index).padStart(2, '0')}.png`);
  await Promise.all(extras.map(path => put(sourceRoot, `batch/${path}`, path)));

  const targetRoot = 'game/figure/split-update';
  await put(projectRoot, `${targetRoot}/model.json`, JSON.stringify(targetManifest));
  await put(projectRoot, `${targetRoot}/model.moc`, 'moc');
  await Promise.all(textures.map(path => put(projectRoot, `${targetRoot}/${path}`, path)));

  const input = {
    projectId: 'test',
    sourceId: 'models',
    modelPath: 'batch/model.json',
    rootPath: 'batch',
    targetDirectory: 'split-update',
    motions: [{ name: 'new/action' }],
    extraPaths: extras,
  };
  const host = await coordinator();
  const first = await planned(host, input);
  expect(first.review).toMatchObject({
    blockingIssues: [],
    batch: { index: 0, total: 2, entryIncluded: false, nextBatchIndex: 1 },
  });
  expect(await host.apply(owner, first.session.id, first.plan.planId!, 'split-update-first'))
    .toMatchObject({ status: 'complete' });

  const finalDraft = await draft({
    ...input,
    batchIndex: 1,
    previousPlanId: first.plan.planId!,
  });
  expect(finalDraft).toMatchObject({
    blockingIssues: [],
    batch: { index: 1, total: 2, entryIncluded: true, nextBatchIndex: null },
  });
  const finalSession = host.sessions.begin(owner, 'test', statement, finalDraft.paths);
  let finalPlan: WritePlan | undefined;
  const persisted = await planLive2dImport(config, {
    mode: 'curated',
    ...input,
    batchIndex: 1,
    previousPlanId: first.plan.planId!,
    sessionId: finalSession.id,
    expectedBundleRevision: finalDraft.bundleRevision!,
  }, async (sessionId, files, bundle) => {
    finalPlan = await host.plan(owner, sessionId, 'test', files, undefined, undefined, bundle);
    return finalPlan;
  });
  expect(persisted.blockingIssues).toEqual([]);
  expect(finalPlan?.modelBundle?.dependencies).toHaveLength(36);

  await put(projectRoot, `${targetRoot}/model.moc`, 'changed after review');
  expect(await host.apply(owner, finalSession.id, finalPlan!.id, 'split-update-final'))
    .toMatchObject({ status: 'uncertain', errorCode: 'REVISION_CONFLICT' });
  expect(JSON.parse(await readFile(join(projectRoot, `${targetRoot}/model.json`), 'utf8')))
    .toEqual(targetManifest);
});

it('blocks base-reference drift and validates every final manifest reference', async () => {
  const common = {
    version: 'Sample 1.0.0',
    layout: {},
    hit_areas_custom: {},
    model: 'model.moc',
    motions: {},
    expressions: [],
  };
  await put(sourceRoot, 'base-source/model.json', JSON.stringify({
    ...common,
    textures: ['new.png'],
  }));
  await put(sourceRoot, 'base-source/model.moc', 'moc');
  await put(sourceRoot, 'base-source/new.png', 'new');
  const driftedTarget = 'game/figure/base-conflict';
  await put(projectRoot, `${driftedTarget}/model.json`, JSON.stringify({
    ...common,
    textures: ['old.png'],
  }));
  await put(projectRoot, `${driftedTarget}/model.moc`, 'moc');

  const drifted = await draft({
    projectId: 'test',
    sourceId: 'models',
    modelPath: 'base-source/model.json',
    rootPath: 'base-source',
    targetDirectory: 'base-conflict',
  });
  expect(drifted.blockingIssues).toEqual(expect.arrayContaining([
    { code: 'TARGET_CONFLICT', path: 'game/figure/base-conflict/model.json' },
    { code: 'DEPENDENCY_MISSING', path: 'game/figure/base-conflict/old.png' },
  ]));
  expect(drifted).toMatchObject({ noOp: false, committable: false, planId: null });

  await put(sourceRoot, 'missing-ref-source/model.json', JSON.stringify({
    ...common,
    textures: ['same.png'],
  }));
  await put(sourceRoot, 'missing-ref-source/model.moc', 'moc');
  await put(sourceRoot, 'missing-ref-source/same.png', 'same');
  const missingReferenceTarget = 'game/figure/missing-reference';
  await put(projectRoot, `${missingReferenceTarget}/model.json`, JSON.stringify({
    ...common,
    textures: ['same.png'],
    motions: {'old/action': [{ file: 'missing.mtn' }]},
  }));
  await put(projectRoot, `${missingReferenceTarget}/model.moc`, 'moc');
  await put(projectRoot, `${missingReferenceTarget}/same.png`, 'same');

  const missingReference = await draft({
    projectId: 'test',
    sourceId: 'models',
    modelPath: 'missing-ref-source/model.json',
    rootPath: 'missing-ref-source',
    targetDirectory: 'missing-reference',
  });
  expect(missingReference.blockingIssues).toEqual(expect.arrayContaining([
    { code: 'DEPENDENCY_MISSING', path: 'game/figure/missing-reference/missing.mtn' },
  ]));
  expect(missingReference).toMatchObject({ noOp: false, committable: false, planId: null });
});

it('rejects a dependency-only batch when the existing entry changes after planning', async () => {
  const { targetManifest, input } = await putDependencyOnlyUpdate();
  const host = await coordinator();
  const { review, session, writePlan } = await planned(host, input);

  expect(review).toMatchObject({
    blockingIssues: [],
    paths: ['game/figure/dependency-only/missing.png'],
    batch: { entryIncluded: false },
  });
  expect(writePlan.modelBundle).toMatchObject({
    entryIncluded: false,
    targetEntryRevision: revision(JSON.stringify(targetManifest)),
    targetReferences: [{
      path: 'game/figure/dependency-only/old.mtn',
      revision: revision('old motion'),
    }],
  });

  await put(projectRoot, 'game/figure/dependency-only/model.json', JSON.stringify({
    ...targetManifest,
    textures: ['existing.png'],
  }));
  await expect(host.apply(owner, session.id, writePlan.id, 'dependency-entry-changed'))
    .rejects.toMatchObject({ code: 'REVISION_CONFLICT' });
  await expect(readFile(join(projectRoot, 'game/figure/dependency-only/missing.png')))
    .rejects.toMatchObject({ code: 'ENOENT' });
});

it('rejects a dependency-only batch when a retained reference changes after planning', async () => {
  const { input } = await putDependencyOnlyUpdate();
  const host = await coordinator();
  const { session, writePlan } = await planned(host, input);

  expect(writePlan.modelBundle?.targetReferences).toContainEqual({
    path: 'game/figure/dependency-only/old.mtn',
    revision: revision('old motion'),
  });
  await put(projectRoot, 'game/figure/dependency-only/old.mtn', 'changed after planning');
  await expect(host.apply(owner, session.id, writePlan.id, 'dependency-reference-changed'))
    .rejects.toMatchObject({ code: 'REVISION_CONFLICT' });
  await expect(readFile(join(projectRoot, 'game/figure/dependency-only/missing.png')))
    .rejects.toMatchObject({ code: 'ENOENT' });
});

it('applies an unchanged dependency-only batch with bound entry and retained references', async () => {
  const { input } = await putDependencyOnlyUpdate();
  const host = await coordinator();
  const { session, writePlan } = await planned(host, input);

  expect(await host.apply(owner, session.id, writePlan.id, 'dependency-only-success'))
    .toMatchObject({ status: 'complete' });
  expect(await readFile(join(projectRoot, 'game/figure/dependency-only/missing.png'), 'utf8'))
    .toBe('missing');
});

it('rejects sourceMappings that do not belong to a streamed operation', async () => {
  await put(sourceRoot, 'mapping/model.json', JSON.stringify({
    version: 'Sample 1.0.0',
    layout: {},
    hit_areas_custom: {},
    model: 'model.moc',
    textures: ['texture.png'],
    motions: {},
    expressions: [],
  }));
  await put(sourceRoot, 'mapping/model.moc', 'moc');
  await put(sourceRoot, 'mapping/texture.png', 'png');
  const input = {
    projectId: 'test',
    sourceId: 'models',
    modelPath: 'mapping/model.json',
    rootPath: 'mapping',
    targetDirectory: 'mapping',
  };
  const review = await draft(input);
  const host = await coordinator();
  const session = host.sessions.begin(owner, 'test', statement, review.paths);
  const result = await planLive2dImport(config, {
    mode: 'curated',
    ...input,
    sessionId: session.id,
    expectedBundleRevision: review.bundleRevision!,
  }, (sessionId, files, bundle) => host.plan(
    owner,
    sessionId,
    'test',
    files,
    undefined,
    undefined,
    {
      ...bundle,
      sourceMappings: [
        ...(bundle.sourceMappings ?? []),
        { targetRelativePath: 'orphan.png', sourceRelativePath: 'orphan.png' },
      ],
    },
  ));
  expect(result.blockingIssues).toEqual(expect.arrayContaining([{ code: 'STATE_CORRUPT' }]));
  expect(result).toMatchObject({ committable: false, planId: null });
});
