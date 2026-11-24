import { randomUUID } from 'node:crypto';
import type { CallToolResult, McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';
import { AppError } from './errors.js';
import { getProject } from './config.js';
import { inspectSource } from './assets/source.js';
import { WriteCoordinator, type CoordinatorOptions } from './changes/coordinator.js';
import { BusinessWriteService, type BusinessOperation } from './changes/business.js';
import { WRITE_LIMITS, type ApplyResult } from './changes/types.js';
import { assertWritePath } from './changes/targets.js';
import type { AppConfig } from './types.js';
import { planLive2dImport } from './live2d/import.js';

export interface WriteToolOptions { stateRoot?: string; coordinatorOptions?: CoordinatorOptions }
type Result = (operation: () => unknown | Promise<unknown>) => Promise<CallToolResult>;
const id = z.string().min(1).max(64);
const uuid = z.string().uuid();
const relative = z.string().min(1).max(1024);
const revision = z.string().regex(/^[a-f0-9]{64}$/);
const key = z.string().regex(/^[a-zA-Z0-9_-]{1,128}$/);
const packageRoot = z.string().max(1024);
const annotation = { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false };
const readAnnotation = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
const edit = z.object({ start: z.number().int().min(0).describe('Zero-based UTF-16 offset in the original decoded text, excluding UTF-8 BOM.'), end: z.number().int().min(0).describe('Exclusive UTF-16 end offset in that same original text.'), text: z.string().max(WRITE_LIMITS.maxFileBytes) }).strict();
const operation = z.discriminatedUnion('type', [
  z.object({ type: z.literal('create_scene'), path: relative.describe('Relative to game/scene, ending .txt; parent directory must exist.'), text: z.string().max(WRITE_LIMITS.maxFileBytes) }).strict(),
  z.object({ type: z.literal('edit_scene'), path: relative.describe('Relative to game/scene, ending .txt.'), expectedRevision: revision, edits: z.array(edit).min(1).max(256) }).strict(),
  z.object({ type: z.literal('edit_config'), expectedRevision: revision, updates: z.array(z.object({ key: z.string().min(1).max(128), value: z.string().max(WRITE_LIMITS.maxFileBytes) }).strict()).min(1).max(64) }).strict(),
  z.object({ type: z.literal('import_asset'), kind: z.enum(['background', 'figure', 'bgm', 'vocal', 'video']), path: relative.describe('Relative to game/<kind>; new file only, parent directory must exist.'), sourceId: id, sourcePath: relative.describe('Relative to the configured sourceId root.'), expectedSourceRevision: revision }).strict()
]);

/** Convert private storage paths to opaque batch-local identifiers. */
function publicApply(value: ApplyResult) {
  return { batchId: value.batchId, status: value.status, replayed: value.replayed, errorCode: value.errorCode ?? null, warnings: value.warnings ?? [], operations: value.operations.map((op, index) => ({ path: op.path, beforeRevision: op.expectedRevision, afterRevision: op.newRevision, phase: op.phase, backupId: op.backup ? `${value.batchId}:${index}` : null })) };
}

export function registerWriteTools(server: McpServer, config: AppConfig, options: WriteToolOptions, result: Result) {
  const ownerId = randomUUID();
  let disconnected = false;
  let runtime: Promise<{ coordinator: WriteCoordinator; business: BusinessWriteService }> | undefined;
  const sessions = new Map<string, { projectId: string; paths: string[]; batches: { batchId: string; status: string }[] }>();
  function getRuntime() {
    if (disconnected) throw new AppError('HANDOFF_REQUIRED', 'The client connection is closed.');
    runtime ??= WriteCoordinator.create(config, options.stateRoot!, options.coordinatorOptions).then(coordinator => {
      if (disconnected) {
        coordinator.sessions.disconnect(ownerId);
        throw new AppError('HANDOFF_REQUIRED', 'The client disconnected during initialization.');
      }
      return { coordinator, business: new BusinessWriteService(config, coordinator, ownerId) };
    });
    return runtime;
  }
  const previousClose = server.server.onclose;
  server.server.onclose = () => {
    disconnected = true;
    void runtime?.then(value => value.coordinator.sessions.disconnect(ownerId)).catch(() => {});
    sessions.clear();
    previousClose?.();
  };
  server.registerTool('asset_source_list', { description: 'List configured local asset source identifiers, without physical paths.', inputSchema: z.object({}).strict(), annotations: readAnnotation }, () => result(() => ({ sources: config.sources.map(source => ({ id: source.id })) })));
  server.registerTool('asset_source_inspect', { description: 'Inspect a registered local source file: raw-byte revision and size only. No binary content, downloads or writes.', inputSchema: z.object({ sourceId: id, path: relative }).strict(), annotations: readAnnotation }, args => result(() => inspectSource(config, args.sourceId, args.path)));
  server.registerTool('write_session_begin', {
    description: 'Only call after a fresh explicit USER reply confirming successful save and exit from ALL editor pages for this project. Ask using the client user interaction first. Never invent the reply or turn a generated boolean into confirmation. Records an attestation, not automatic dirty-state detection. One reply covers the declared batch paths.',
    inputSchema: z.object({ projectId: id, paths: z.array(relative.describe('Exact project-relative target, e.g. game/scene/start.txt, game/background/new.png, game/config.txt.')).min(1).max(WRITE_LIMITS.maxFiles), decision: z.enum(['saved-and-editors-closed', 'not-ready']), statement: z.string().trim().min(1).max(2048).describe('The current user reply; never fabricate it or copy an expired handoff.') }).strict(), annotations: { ...annotation, destructiveHint: false }
  }, args => result(async () => {
    getProject(config, args.projectId);
    if (args.decision !== 'saved-and-editors-closed') {
      if (runtime) {
        const { coordinator } = await runtime;
        for (const [sessionId, session] of sessions) {
          if (session.projectId === args.projectId) coordinator.sessions.pause(sessionId);
        }
      }
      throw new AppError('HANDOFF_REQUIRED', 'Save successfully and leave all editing pages before handing over. Existing handoffs for this project were revoked; no new session was created.');
    }
    if (sessions.size >= 32) throw new AppError('LIMIT_EXCEEDED', 'End existing handoff sessions before creating more.');
    for (const path of args.paths) { try { assertWritePath(path, false); } catch { assertWritePath(path, true); } }
    const { coordinator } = await getRuntime();
    const session = coordinator.sessions.begin(ownerId, args.projectId, { source: 'user-message', statement: args.statement }, args.paths);
    sessions.set(session.id, { projectId: args.projectId, paths: [...args.paths], batches: [] });
    return { sessionId: session.id, projectId: session.projectId, paths: session.paths, expiresAt: session.expiresAt, userAttested: true, automaticDirtyCheck: false, reminder: 'Keep all editor pages closed until this session is ended. This is a user statement, not a technical editor lock.' };
  }));
  server.registerTool('change_plan', { description: 'Review create_scene/edit_scene/import_asset/edit_config candidates. Without a handoff returns a non-committable draft. With a fresh handoff rereads targets and stores a version-bound plan. Source files are imported before scene/config changes. Does not modify game files.', inputSchema: z.object({ projectId: id, sessionId: uuid.optional(), operations: z.array(operation).min(1).max(WRITE_LIMITS.maxFiles) }).strict(), annotations: { ...annotation, destructiveHint: false } }, args => result(async () => {
    const { business } = await getRuntime();
    return business.plan(args.projectId, args.sessionId, args.operations as BusinessOperation[]);
  }));
  server.registerTool('change_apply', { description: 'Apply a reviewed plan within the current user handoff, after source/target revision checks and backups. Reuse the same idempotency key only for the same plan. Partial/uncertain outcomes require inspection; never automatically overwrite or force conflicts.', inputSchema: z.object({ sessionId: uuid, planId: uuid, idempotencyKey: key }).strict(), annotations: { ...annotation, idempotentHint: true } }, args => result(async () => {
    const { business } = await getRuntime();
    const outcome = await business.apply(args.sessionId, args.planId, args.idempotencyKey);
    const session = sessions.get(args.sessionId);
    if (session && !session.batches.some(batch => batch.batchId === outcome.batchId)) session.batches.push({ batchId: outcome.batchId, status: outcome.status });
    return outcome;
  }));
  server.registerTool('live2d_import_plan', {
    description: 'Draft a complete Live2D bundle, or a curated first/incremental import using selected motion members, registered or unregistered expressions, and only their dependencies. Curated game copies rename dot-prefixed path segments to underscore-prefixed names, rewrite all manifest references, and return gameEntry with before/after revisions and motion, expression, and resource changes. Each batch allows 32 files and 128 MiB, with up to 100 MiB per resource and 1 MiB per entry JSON. Curated imports publish dependencies before the final manifest batch. After user handoff, pass sessionId and the reviewed bundleRevision to create a plan for change_apply.',
    inputSchema: z.object({
      projectId: id, sourceId: id, modelPath: relative,
      targetDirectory: z.string().min(1).max(255).describe('One directory name under game/figure. Curated mode can update an existing model directory.'),
      extraPaths: z.array(relative).max(WRITE_LIMITS.maxFiles).optional(),
      mode: z.enum(['bundle', 'curated']).optional().describe('Defaults to the existing whole-bundle import. Use curated for dependency-only and incremental imports.'),
      rootPath: packageRoot.optional().describe('Package root relative to the source root. Required for curated mode and normally copied from live2d_model_discover.'),
      motions: z.array(z.object({
        name: z.string().min(1).max(256),
        memberIndex: z.number().int().min(0).max(1024).optional(),
        outputName: z.string().min(1).max(256).optional(),
      }).strict()).max(100).optional(),
      expressions: z.array(z.object({
        name: z.string().min(1).max(256),
        file: relative.optional(),
      }).strict()).max(100).optional(),
      batchIndex: z.number().int().min(0).max(10_000).optional(),
      previousPlanId: uuid.optional(),
      sessionId: uuid.optional(), expectedBundleRevision: revision.optional(),
    }).strict(),
    annotations: { ...annotation, destructiveHint: false },
  }, args => result(() => planLive2dImport(config, args, async (sessionId, files, model) => {
    const { coordinator } = await getRuntime();
    return coordinator.plan(ownerId, sessionId, args.projectId, files, undefined, undefined, model);
  })));
  server.registerTool('write_session_end', { description: 'End this handoff and return control to the user. Report recorded batches; inspect partial/uncertain outcomes before resuming editing. Reopen Terre pages to load changed files.', inputSchema: z.object({ sessionId: uuid }).strict(), annotations: { ...annotation, destructiveHint: false } }, args => result(async () => {
    const { coordinator } = await getRuntime();
    coordinator.sessions.end(args.sessionId, ownerId);
    const summary = sessions.get(args.sessionId);
    sessions.delete(args.sessionId);
    return { sessionId: args.sessionId, state: 'closed', projectId: summary?.projectId ?? null, batches: summary?.batches ?? [], reminder: 'Inspect incomplete or uncertain batches first. Reopen Terre editing pages to load disk changes; preview and package manually.' };
  }));
  server.registerTool('recovery_inspect', { description: 'Read batch/disk/backup state and lock status without handoff or target writes. Omit batchId to discover unfinished batches; use planId to find even completed requests after a lost receipt/restart, or includeCompleted for history. Bounded pagination; snapshot only, no restoration authority.', inputSchema: z.object({ projectId: id, batchId: uuid.optional(), planId: uuid.optional(), includeCompleted: z.boolean().optional(), offset: z.number().int().min(0).max(1024).optional(), limit: z.number().int().min(1).max(10).optional() }).strict(), annotations: readAnnotation }, args => result(async () => {
    const { coordinator } = await getRuntime();
    const lock = await coordinator.locks.inspect(getProject(config, args.projectId).root);
    if (args.batchId) return { ...await coordinator.inspect(args.projectId, args.batchId), lock };
    const pending = await coordinator.pending(args.projectId, { planId: args.planId, includeCompleted: args.includeCompleted });
    const offset = args.offset ?? 0, limit = args.limit ?? 10;
    return { batches: pending.batches.slice(offset, offset + limit), total: pending.batches.length, nextOffset: offset + limit < pending.batches.length ? offset + limit : null, unreadableRecords: pending.unreadableRecords, lock };
  }));
  server.registerTool('recovery_restore', { description: 'Restore ONLY files explicitly selected by the user after recovery_inspect and a fresh save/leave handoff. Check their current revisions and verified backups; back up current content first. Never remove created files or overwrite later edits.', inputSchema: z.object({ projectId: id, sessionId: uuid, batchId: uuid, selected: z.array(z.object({ path: relative, expectedRevision: revision }).strict()).min(1).max(WRITE_LIMITS.maxFiles), idempotencyKey: key }).strict(), annotations: { ...annotation, idempotentHint: true } }, args => result(async () => {
    const { coordinator } = await getRuntime();
    const outcome = await coordinator.restore(ownerId, args.sessionId, args.projectId, args.batchId, args.selected, args.idempotencyKey);
    const session = sessions.get(args.sessionId);
    if (session && !session.batches.some(batch => batch.batchId === outcome.batchId)) session.batches.push({ batchId: outcome.batchId, status: outcome.status });
    return publicApply(outcome);
  }));
  server.registerTool('recovery_reclaim_lock', { description: 'Explicitly reclaim a dead MCP process lock using the exact token from recovery_inspect. Refuses live/unknown owners and maintenance remnants. Does not restore game files or establish a handoff.', inputSchema: z.object({ projectId: id, token: z.string().min(1).max(128) }).strict(), annotations: { ...annotation, destructiveHint: false } }, args => result(async () => {
    const { coordinator } = await getRuntime();
    await coordinator.locks.reclaim(getProject(config, args.projectId).root, args.token);
    return { projectId: args.projectId, reclaimed: true, handoffRequired: true };
  }));
}
