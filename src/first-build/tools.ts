import type { CallToolResult, McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { WRITE_LIMITS } from '../changes/types.js';
import { LIMITS, type AppConfig } from '../types.js';
import { operation, type WriteToolOptions } from '../write-tools.js';
import { FirstBuildService } from './service.js';

const relative = z.string().min(1).max(1024);
const revision = z.string().regex(/^[a-f0-9]{64}$/);
const runId = z.string().uuid();
const read = { readOnlyHint: true, destructiveHint: false, openWorldHint: false };
const write = { readOnlyHint: false, destructiveHint: false, openWorldHint: false };

export function registerFirstBuildTools(
  server: McpServer,
  config: AppConfig,
  options: WriteToolOptions,
  result: (operation: () => unknown | Promise<unknown>) => Promise<CallToolResult>,
) {
  const service = new FirstBuildService(config, config.firstBuild!, options.stateRoot!, options.coordinatorOptions);
  const close = server.server.onclose;
  server.server.onclose = () => { service.close(); close?.(); };

  server.registerTool('first_build_begin', {
    description: 'Create a new isolated Creator workspace ONLY after the user explicitly approves this first build, including the reviewed story and exact scope. Use the user’s actual current statement. Existing projects remain on the Terre handoff tools.',
    inputSchema: z.object({
      storyRevision: revision,
      scenes: z.array(relative).min(1).max(LIMITS.entries),
      assets: z.array(z.object({
        kind: z.enum(['background', 'figure', 'bgm', 'vocal', 'video']),
        path: relative, sourceId: z.string().min(1).max(64), sourcePath: relative, expectedSourceRevision: revision,
      }).strict()).max(LIMITS.entries),
      configKeys: z.array(z.string().min(1).max(128)).max(64),
      statement: z.string().trim().min(1).max(2048),
    }).strict(), annotations: write
  }, ({ statement, ...scope }) => result(() => service.begin(scope, statement)));

  server.registerTool('first_build_apply', {
    description: 'Plan, apply and verify one in-scope batch under a current isolated first-build grant. Reuse an idempotency key only for the same batch. On FIRST_BUILD_CONFIRMATION_REQUIRED stop all writes for this run, inspect, then ask the user what to do.',
    inputSchema: z.object({ runId, storyRevision: revision,
      idempotencyKey: z.string().regex(/^[a-zA-Z0-9_-]{1,128}$/),
      operations: z.array(operation).min(1).max(WRITE_LIMITS.maxFiles),
    }).strict(), annotations: { ...write, idempotentHint: true }
  }, args => result(() => service.apply(args.runId, args.storyRevision, args.idempotencyKey, args.operations)));

  server.registerTool('first_build_inspect', {
    description: 'Read isolated build progress, verified batches, and project diagnostics. After reconnecting, a known run ID can read the previous connection’s saved batch receipts only. Specify a scene path for its saved text and static analysis; candidateText optionally validates proposed scene text.',
    inputSchema: z.object({ runId, scenePath: relative.optional(),
      candidateText: z.string().max(LIMITS.textBytes).optional(),
    }).strict().refine(args => args.candidateText === undefined || args.scenePath !== undefined), annotations: read
  }, args => result(() => service.inspect(args.runId, args.scenePath, args.candidateText)));

  server.registerTool('first_build_preview', {
    description: 'Serve a verified snapshot with a local read-only player. To deliver, check the current candidate in Chrome, then pass its snapshotId with deliver: true. Delivery checks the required outputs, returns that same snapshot, and ends the write grant. Preview does not register anything in Terre.',
    inputSchema: z.object({ runId, deliver: z.boolean(), snapshotId: z.string().uuid().optional() }).strict(), annotations: write
  }, args => result(() => service.preview(args.runId, args.deliver, args.snapshotId)));

  server.registerTool('first_build_cancel', {
    description: 'Revoke this first-build grant. Keep the existing work, snapshots and receipts for inspection.',
    inputSchema: z.object({ runId }).strict(), annotations: write
  }, args => result(() => service.cancel(args.runId)));
}
