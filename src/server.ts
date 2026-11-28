import { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';
import { publicError, AppError } from './errors.js';
import { ReadService, ASSET_DIRS } from './service.js';
import { PROJECT_SCAN_LIMITS } from './project-scan.js';
import { LIMITS, type AppConfig } from './types.js';
import { registerWriteTools, type WriteToolOptions } from './write-tools.js';
import { registerFirstBuildTools } from './first-build/tools.js';
import { discoverLive2dModels } from './live2d/discover.js';
import { inspectLive2dModel, listLive2dModelEntries } from './live2d/model.js';

const projectId = z.string().min(1).max(64);
const relativePath = z.string().min(1).max(1024);
const paging = { cursor: z.string().max(1024).optional(), limit: z.number().int().min(1).max(LIMITS.pageSize).optional() };
const annotations = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };

export function serverInstructions(writeToolsEnabled: boolean, firstBuildEnabled = false): string {
  if (!writeToolsEnabled) {
    return [
      'webgal-mcp 当前为只读模式（仅开放只读工具）。',
      '- 排查连接、工程文件或 Terre 映射时先调用 webgal_status；不要臆测未读取的场景、配置或素材内容。',
      '- 读取结果为磁盘上已保存内容，不代表 WebGAL Terre 中未保存的编辑器缓冲。',
      '- scene_validate、project_scan、live2d_model_discover、live2d_model_inspect、live2d_model_entries 仅为静态检查，不运行游戏、不访问外部 URL，动态引用需由用户在 Terre 预览确认。',
      '- 如需受控写入，须在 MCP 启动参数中配置位于所有工程和素材目录之外的 --state-root 并重启连接。',
    ].join('\n');
  }
  return [
    '以下人工交接流程用于本机配置已登记的 Terre 工程：',
    ...(firstBuildEnabled ? [
      '- Creator 的隔离首版使用独立的 first_build_* 工具。只有用户审核本次新工程范围并明确授权后才调用 first_build_begin。遇到 FIRST_BUILD_CONFIRMATION_REQUIRED 时暂停并请求用户决定，不复用原授权或改用普通写入工具。'
    ] : []),
    '1. 排查连接与映射先调用 webgal_status；不要臆测未读取的内容，磁盘读取不代表 Terre 未保存缓冲。',
    '2. 修改或导入前，先用 change_plan 或 live2d_import_plan（不传 sessionId）生成只读草案给用户审阅。',
    '3. 真正写入前，必须等待用户明确回复确认已在 WebGAL Terre 中成功保存并关闭该工程的全部编辑页；随后用用户本次原话调用 write_session_begin，绝不伪造、推断或复用旧回复。',
    '4. 交接后重新生成可应用计划并让用户再次确认；记录 planId 后调用 change_apply，完成后调用 write_session_end 交回编辑权。',
    '5. 遇到冲突、failed、partial、uncertain 或回执丢失时，禁止自动重试覆盖，必须先调用 recovery_inspect 核对磁盘与批次状态。',
  ].join('\n');
}

export function createServer(config: AppConfig, options: WriteToolOptions = {}) {
  config = structuredClone(config);
  const writeToolsEnabled = Boolean(options.stateRoot);
  const firstBuildEnabled = writeToolsEnabled && Boolean(config.firstBuild);
  const server = new McpServer(
    { name: 'webgal-mcp', version: '0.3.0' },
    { instructions: serverInstructions(writeToolsEnabled, firstBuildEnabled) },
  );
  const service = new ReadService(config);
  async function result(operation: () => unknown | Promise<unknown>) {
    try {
      const data = await operation();
      const text = JSON.stringify(data);
      const businessFailure = typeof data === 'object' && data !== null && 'status' in data && ['failed', 'partial', 'uncertain'].includes(String(data.status));
      const response = { ...(businessFailure ? { isError: true } : {}), content: [{ type: 'text' as const, text }], structuredContent: { data } };
      if (Buffer.byteLength(JSON.stringify(response), 'utf8') > LIMITS.responseBytes) throw new AppError('LIMIT_EXCEEDED', 'The result exceeds the response limit. Use a smaller page or narrower query.');
      return response;
    } catch (error) {
      const detail = publicError(error);
      return { isError: true, content: [{ type: 'text' as const, text: JSON.stringify({ error: detail }) }], structuredContent: { error: detail } };
    }
  }
  server.registerTool('webgal_status', {
    description: 'Check local project files, Terre connectivity and project mapping, and get next steps. Pass projectId for project checks. Reports write-tool availability and the manual handoff requirement.',
    inputSchema: z.object({ projectId: projectId.optional() }).strict(),
    annotations,
  }, args => result(async () => {
    const status = await service.status(args.projectId);
    const writeNextStep = writeToolsEnabled
      ? '每批写入前，请用户在 Terre 中成功保存、关闭该工程的所有编辑页，再明确确认本批交接。'
      : '如需修改文件，在 MCP 启动参数中添加 --state-root，指定与所有工程和素材目录分开的私有目录，再重启 MCP 连接。';
    return {
      ...status,
      ...(writeToolsEnabled ? { stage: 'P3', readOnly: false } : {}),
      writeToolsEnabled,
      handoffRequired: true,
      nextSteps: [...status.nextSteps, writeNextStep],
    };
  }));
  server.registerTool('project_list', { description: 'List only projects authorized in the local configuration.', inputSchema: z.object(paging).strict(), annotations }, args => result(() => service.projects(args)));
  server.registerTool('project_inspect', { description: 'Inspect an authorized WebGAL project and its configuration summary. Use webgal_status with the projectId for connection troubleshooting and next steps.', inputSchema: z.object({ projectId }).strict(), annotations }, args => result(async () => ({ ...await service.inspect(args.projectId), ...(writeToolsEnabled ? { readOnly: false, writeToolsEnabled: true, writeAuthorization: 'per-session' } : {}) })));
  server.registerTool('project_scan', {
    description: 'Report missing and unverified references in saved scenes of an authorized project. Read-only and bounded. Check coverage and continue with scope.nextStartAfter when present. Does not fetch URLs or run the game.',
    inputSchema: z.object({
      projectId,
      limit: z.number().int().min(1).max(PROJECT_SCAN_LIMITS.scenes).optional(),
      startAfter: z.string().min(1).max(32767).optional(),
    }).strict(),
    annotations,
  }, args => result(() => service.scan(args.projectId, args)));
  server.registerTool('scene_list', { description: 'List .txt scenes recursively, with paths relative to game/scene and bounded pagination.', inputSchema: z.object({ projectId, ...paging }).strict(), annotations }, args => result(() => service.scenes(args.projectId, args)));
  server.registerTool('scene_read', { description: 'Read a UTF-8 scene from disk with raw-byte SHA-256 revision and newline metadata. It may differ from unsaved Terre content.', inputSchema: z.object({ projectId, path: relativePath }).strict(), annotations }, args => result(() => service.scene(args.projectId, args.path)));
  server.registerTool('scene_validate', { description: 'Analyze scene syntax and static references without executing scripts or fetching resources. Dynamic references remain unresolved.', inputSchema: z.object({ projectId, path: relativePath, candidateText: z.string().max(LIMITS.textBytes).optional() }).strict(), annotations }, args => result(() => service.validate(args.projectId, args.path, args.candidateText)));
  server.registerTool('asset_list', { description: 'List existing assets in known game asset directories; no import, overwrite or download.', inputSchema: z.object({ projectId, kind: z.enum(Object.keys(ASSET_DIRS) as [keyof typeof ASSET_DIRS, ...(keyof typeof ASSET_DIRS)[]]).optional(), ...paging }).strict(), annotations }, args => result(() => service.assets(args.projectId, args.kind, args)));
  server.registerTool('live2d_model_discover', {
    description: 'Discover Cubism 2 model.json and Cubism 3 .model3.json candidates in one registered source or project figure directory. Reports format, static status, and bounded item counts without loading Cubism or running the game.',
    inputSchema: z.object({
      location: z.discriminatedUnion('kind', [
        z.object({ kind: z.literal('project'), projectId }).strict(),
        z.object({ kind: z.literal('source'), sourceId: projectId }).strict(),
      ]),
      directory: z.string().max(1024).optional().describe('Relative to the registered source root or game/figure.'),
      offset: z.number().int().min(0).max(10_000).optional(),
      limit: z.number().int().min(1).max(100).optional(),
    }).strict(),
    annotations,
  }, args => result(() => discoverLive2dModels(config, args)));
  server.registerTool('live2d_model_inspect', {
    description: 'Inspect a Cubism 2 model.json or Cubism 3 .model3.json entry, its local dependencies, motion groups, registered expressions, and nearby unregistered expressions. Lists are bounded to 256 entries; use live2d_model_entries for complete paged lookup.',
    inputSchema: z.object({
      location: z.discriminatedUnion('kind', [
        z.object({
          kind: z.literal('project'),
          projectId,
          modelPath: relativePath.describe('Relative to game/figure.'),
          rootPath: z.string().max(1024).optional().describe('Optional boundary relative to game/figure.'),
        }).strict(),
        z.object({
          kind: z.literal('source'),
          sourceId: projectId,
          modelPath: relativePath.describe('Relative to the registered source.'),
          rootPath: z.string().max(1024).optional().describe('Optional boundary relative to the registered source.'),
        }).strict(),
      ]),
    }).strict(),
    annotations,
  }, args => result(() => inspectLive2dModel(config, args.location)));
  server.registerTool('live2d_model_entries', {
    description: 'Page motion, expression, or dependency entries for a Live2D model. Dependencies include resolved root-relative paths. Use expectedRevision to reject pages from a changed model entry.',
    inputSchema: z.object({
      location: z.discriminatedUnion('kind', [
        z.object({ kind: z.literal('project'), projectId, modelPath: relativePath, rootPath: z.string().max(1024).optional() }).strict(),
        z.object({ kind: z.literal('source'), sourceId: projectId, modelPath: relativePath, rootPath: z.string().max(1024).optional() }).strict(),
      ]),
      kind: z.enum(['motion', 'expression', 'dependency']).optional(),
      prefix: z.string().max(256).optional(),
      includeUnregistered: z.boolean().optional(),
      offset: z.number().int().min(0).max(10_000).optional(),
      limit: z.number().int().min(1).max(100).optional(),
      expectedRevision: z.string().length(64).optional(),
    }).strict(),
    annotations,
  }, args => result(() => listLive2dModelEntries(config, args.location, args)));
  server.registerTool('game_config_read', { description: 'Read game/config.txt as original text with a revision and parsed configuration summary.', inputSchema: z.object({ projectId }).strict(), annotations }, args => result(() => service.gameConfig(args.projectId)));
  server.registerTool('preview_get_url', { description: 'Return the configured official Terre preview URL. Does not open a browser, execute preview commands or prove the game runs.', inputSchema: z.object({ projectId }).strict(), annotations }, args => result(() => service.preview(args.projectId)));
  if (writeToolsEnabled) registerWriteTools(server, config, options, result);
  if (firstBuildEnabled) registerFirstBuildTools(server, config, options, result);
  return server;
}
