# webgal-mcp 工具参考

第一次使用请先看 [README 快速上手](../README.md#快速上手)。如果你想从文章开始创作，见 [Creator Skill 用法](../README.md#用-creator-skill-把文章做成短篇)。本页说明工具、路径和写入限制。

## 手动安装

准备 Windows、Git、Node.js 24、Codex CLI 和 [WebGAL Terre](https://github.com/OpenWebGAL/WebGAL_Terre/releases)。启动 Terre，在测试工程里保存一句开场对白。在 PowerShell 中下载并构建 MCP：

```powershell
git clone https://github.com/yuri77521/webgal-mcp-public.git
cd webgal-mcp-public
npm ci
npm run build
```

按下方[本机配置](#本机配置)登记工程和 MCP。要使用 Creator Skill，把 [`skills/webgal-creator`](../skills/webgal-creator/) 整个目录复制到 `~/.agents/skills/webgal-creator`，在 Codex 中调用 `$webgal-creator`。如果找不到 Skill，重启 Codex。[Codex Skill 安装说明](https://learn.chatgpt.com/docs/build-skills#where-codex-loads-local-skills)

编辑已有工程时，将 [webgal-editor](../skills/webgal-editor/) 整个目录复制到同一 skills 目录。需要在场景里编排 Live2D 角色时，再把 [webgal-live2d](../skills/webgal-live2d/) 整个目录复制到所用 Creator 或 Editor 旁边，保留原目录名。两者会在处理模型演出时读取它。普通工程和 Librarian 单独建库均可跳过这一步。

### 单独安装 Librarian

普通素材管理与离线查询需要 Python 3.10 或更高版本。首次为 Live2D 建档或刷新模型信息，另需安装 MCP 并登记模型素材目录。

1. 从仓库中把整个 [`skills/webgal-librarian`](../skills/webgal-librarian/) 目录复制到 `~/.agents/skills/webgal-librarian`，保留其中的 `scripts/`、`references/` 和 `agents/`。
2. 在 PowerShell 运行 `python --version` 确认版本。在新 Codex 对话中调用 `$webgal-librarian`，并提供素材库路径。可直接复制 [README 的接管示例](../README.md#用-librarian-管理共享素材库)。

根 `INDEX.md` 链接到可手动编辑的 Markdown 分册。Creator 和 Editor 使用 Librarian 的有界搜索与本机项目选材记录，可直接从故事初选延续到表情替换。字段、标签分隔符和相对路径写法见[索引格式](../skills/webgal-librarian/references/index-format.md)。

## 本机配置

在仓库目录创建本机配置 `webgal-mcp.local.json`，用实际工程路径和 Terre 端口替换示例值。

```json
{
  "version": 1,
  "projects": [
    {
      "id": "my-game",
      "root": "C:/Games/Terre/my-game",
      "terreUrl": "http://127.0.0.1:3001",
      "terreGameDir": "my-game"
    }
  ],
  "sources": []
}
```

在仓库目录登记到 Codex：

```powershell
$repoPath = (Get-Location).Path
codex mcp add webgal -- node "$repoPath/dist/cli.js" --config "$repoPath/webgal-mcp.local.json"
codex mcp list
```

重新打开 Codex，让它用 `webgal_status` 检查 `my-game`，并用 `scene_read` 读 `start.txt` 的开场对白。遇到问题可查[连接与试改排查](#连接与试改排查)。

也可以手动填写 Codex 的 `config.toml`：

```toml
[mcp_servers.webgal]
command = "node"
args = ["<absolute-repository-path>/dist/cli.js", "--config", "<absolute-local-config-path>"]
```

配置文件 `webgal-mcp.local.json` 可列出多个项目；每个项目有独立 `id`。工程的 `root` 是包含 `game/` 的目录；`terreGameDir` 是 Terre 的工程目录名。省略 Terre 地址和目录名时，仍可只读查看获准的文件。提交写入和取得预览链接需要配置对应的 Terre 工程。文件内相对路径以配置文件所在目录为准。

导入素材前，在配置文件的 `sources` 登记来源目录，例如 `{"id":"assets","root":"./my-assets"}`。导入工具只接受已登记的来源 ID 和目录内相对路径。

CLI 通过 stdio（标准输入输出）与客户端通信。直接在终端启动会等待 MCP 消息。若 Codex 找不到 `node`，可使用 Node.js 可执行文件的绝对路径。客户端仍按自身配置处理工具审批。

若通过 DeepSeek Harness（`dsh`）接入，请参见 [DeepSeek Harness 接入指南](deepseek-harness.md)（含 `Settings → MCP` 与 `cordis.patch.yml` 配置、`mcp__webgal__*` 工具命名及专属排查）。

## 读取工具

| 工具 | 用途 |
| --- | --- |
| `webgal_status` | 传入 `projectId` 检查本机工程、Terre 连接和工程映射，并给出下一步操作 |
| `project_list` | 只列本地配置登记的工程 |
| `project_inspect` | 工程类型、入口、配置摘要、Terre 映射核对 |
| `project_scan` | 检查已保存场景中的本机引用，报告缺失项、未验证项和扫描范围 |
| `scene_list` | 递归列出场景并分页；返回路径相对于 `game/scene` |
| `scene_read` | UTF-8 原文、原始字节 SHA-256、BOM 和换行信息 |
| `scene_validate` | 解析磁盘或候选文本，检查静态引用；不执行脚本、不下载 URL |
| `asset_list` | 列出背景、立绘、BGM、语音、视频、动画目录的既有文件元数据 |
| `live2d_model_discover` | 在登记的素材目录内查找模型入口，比较候选及缺失的基础文件 |
| `live2d_model_inspect` | 按入口内容检查 Cubism 2 或标准 `.model3.json` 的依赖，区分动作组、组内成员和表情 |
| `live2d_model_entries` | 按动作、表情或依赖分页，返回原名、登记状态、播放文件和内容指纹 |
| `game_config_read` | `game/config.txt` 原文、版本及解析摘要 |
| `preview_get_url` | 返回配置对应的官方预览 URL；不打开浏览器、不遥控、不证明游戏已运行 |

排查连接时，先运行 `webgal_status` 并查看 `nextSteps`。省略 `projectId` 可查看全局状态和如何选择工程。

- `projectFiles.readable` 表示 `game/scene` 目录检查和 `game/config.txt` 读取都通过。失败时有 `errorCode`，仍可查看 Terre 结果。
- `terre.connectionStatus` 区分 `not_configured`（未配置）、`no_response`（未收到 HTTP 响应）和 `responded`（收到响应）。收到响应后还需看 `capabilities` 是否核对通过。未收到响应时，需核对 Terre 是否在运行及配置端口是否正确。
- `terre.mappingStatus` 区分 `not_configured`（未配置）、`unverified`（证据不足）、`mismatch`（确认目录不匹配）和 `verified`（已核对一致）。实际预览、运行和导出由用户在 Terre 检查。
- `writeToolsEnabled` 表示是否启用了写入工具。`handoffRequired` 表示每批写入都需要人工交接。检查不查询当前会话，编辑器的未保存状态仍为 `unknown`。

分页参数是 `limit`（1–100）和 `cursor`。文件列表变化或 cursor 不匹配时重新开始列表。工具业务错误使用 `isError=true` 与错误码；参数 schema 错误由 SDK 报告。

`asset_list` 汇总时用 `missingKinds` 明确列出不存在的可选素材目录；指定不存在的 kind 会报错，不把缺失目录当作空目录。

## 连接与试改排查

| 看到什么 | 检查哪里 | 怎么重试 |
| --- | --- | --- |
| Codex 看不到 `webgal`，或 MCP 启动报错 | 用 `codex mcp list` 核对登记，确认 `npm run build` 成功且 `--config` 指向有效 JSON。工程 `root` 要存在，`terreUrl` 和 `terreGameDir` 如使用须一起配置，地址须为本机 HTTP loopback 根地址。 | 修正后重启 Codex，再运行 `webgal_status`。 |
| `projectFiles.readable: false` | 看 `projectFiles.errorCode` 和 `nextSteps`。检查 `root` 下是否有 `game/scene` 与可读的 UTF-8 `game/config.txt`。 | 改过本机配置时先重启 MCP，再检查该工程。 |
| `connectionStatus: no_response`，或有响应但 API 检查失败 | 核对 Terre 是否在运行、`terreUrl` 的端口是否正确，以及该端口返回的是否为 Terre API。 | 地址更改后重启 MCP，再运行 `webgal_status`。如果本机文件可读，也可以先继续只读练习。 |
| `mappingStatus: mismatch` 或 `unverified` | 核对 `root` 和 `terreGameDir` 是否对应同一个工程，并确认 Terre 和 MCP 均可访问。目录名使用实际文件夹名。 | 改过配置后重启 MCP，再检查。试改前等映射为 `verified`，并确认 `apiTest`、`openApi` 和 `readGameAssets` 均为 `available`。 |
| `writeToolsEnabled: false` | 检查 MCP 启动参数是否有 `--state-root` 和独立状态目录。 | 更新参数后重启 MCP，再确认 `writeToolsEnabled` 为 `true`。 |
| `HANDOFF_REQUIRED` 或 `SESSION_EXPIRED` | 确认本批已经在 Terre 保存、关闭该工程的编辑页，并由用户明确交接。 | 重新交接，生成新计划并再次确认后再应用。 |
| 生成计划时出现 `REVISION_CONFLICT` | 重新读取目标文件，核对后来保存的内容。 | 按当前内容重新交接和生成计划，核对改动后再应用。 |
| 应用失败、部分完成、结果不确定或回执丢失 | 保留 `planId` 并保持编辑页关闭。先用 `recovery_inspect` 核对磁盘和批次状态，并处理相关锁警告。 | 确认可继续编辑后再重开 Terre。若需重试，重新交接并生成新计划。 |

## 限制与数据边界

- 只读取已登记工程；路径和真实路径均检查，拒绝越界、Windows 特殊路径和 junction 逃逸。列表跳过链接，不递归跟随链接。
- 场景路径相对于 `game/scene`，不是任意文件读取接口。素材只返回元数据，不向模型传输二进制文件。
- 原文读取上限 1 MiB，整份工具结果上限 2 MiB，单次目录遍历最多 10,000 项，分页最多 100 项。本机 Terre 请求超时 3 秒/请求；输出超限会明确报错，不静默截断原文。
- 当前支持 UTF-8/UTF-8 BOM，拒绝 UTF-16、非法 UTF-8 和二进制。读取的是磁盘内容，不能表示 Terre 未保存 buffer。
- 解析成功不等于脚本完全有效；变量、URL、复杂模型的关联文件等可能无法静态验证。诊断保留这些限制，不把它们当作缺失本机文件。
- Terre 仅允许显式配置的 HTTP loopback 根地址，不跟随重定向，不通过系统代理请求远端。只调用已核对的 test、OpenAPI 与目录读取接口，不调用可能创建目录的用户状态/工程列表或任何写接口。
- 为保证路径边界、原始文件版本和有界分页，递归清单来自授权工程磁盘；官方 REST 用于连接、契约和逻辑路径映射交叉核对。不会使用静态服务的引擎回退来伪装工程文件存在。
- 不发送遥测或上传文件；工具返回内容交给 MCP Client，后续模型处理由客户端配置决定。
- 路径和读取期间的变化会尽量拒绝；不承诺对恶意本地进程提供文件系统沙箱。读取不代表获得工程写入权限。

## 导出前检查工程

让 Codex 运行 `project_scan`，只需传入 `projectId`。它递归检查 `game/scene` 下已保存的 `.txt`，按场景相对路径排序，跳过文件或目录链接。它从磁盘检查工程内的素材和跳转目标，外部 URL、编辑器缓冲区和游戏运行状态留给人工预览核对。

- 每个场景列出检测结果。问题包含行号、可安全显示的目标和原因。`missing` 表示确定缺失的本机文件，`unverified` 表示动态引用、外部 URL 或其他无法确认的项。`target` 仅显示可安全表达的工程相对路径。
- `scope` 列出总场景数、已检查数、未完成数及剩余范围。清单读取失败时总数为 `null`，错误码在 `inventoryError`。`complete` 表示本次已检查整个清单，缺失和待人工验证的项目仍需处理。
- 单次最多检查 100 个场景，清单最多处理 10,000 项，单个场景最多 128 KiB，场景与问题详情合计最多 128 KiB。5 秒预算在目录处理、读取和分析阶段之间检查，已经开始的单次文件系统或解析操作可以超出预算。`stopReason` 标出触发的上限。
- 还剩场景时，将 `scope.nextStartAfter` 作为下一次调用的 `startAfter`。可以用 `limit` 指定每批 1–100 个场景。遇到个别未完成的场景，可按原因处理后用 `scene_validate` 复查。工程在分批检查之间发生变化时，从头重新检查。

在 Terre 中预览关键场景并自行导出。

## 启用受控写入

```powershell
node dist/cli.js --config webgal-mcp.local.json --state-root "<absolute-private-state-directory>"
```

将同样的 `--state-root` 参数加入客户端启动 args，再重启 MCP 连接。状态目录必须在所有工程和素材来源之外，且不能包含它们；不使用游戏目录存放备份/日志。状态目录包含原始剧情和备份，不加密、不自动清理。相对 state-root 基于启动目录，建议使用绝对路径。

新增工具：

| 工具 | 用途 |
| --- | --- |
| `asset_source_list` | 列出已登记来源 ID，不暴露物理根目录 |
| `asset_source_inspect` | 来源文件原始 SHA-256 与大小，不向模型发送二进制 |
| `write_session_begin` | 记录本次用户保存/离开声明、工程和精确路径范围；未准备好时拒绝并撤销该工程先前交接 |
| `change_plan` | 创建/编辑场景、导入素材、修改配置的有界方案；无会话只生成不可提交草案 |
| `live2d_import_plan` | 审阅 Live2D 模型包及目标文件；交接后生成供 `change_apply` 使用的计划 |
| `change_apply` | 版本及来源复核、全部备份后提交；同计划同键幂等重放 |
| `write_session_end` | 结束写入会话并返回批次摘要。部分完成或结果不确定时，先核对恢复状态，再重开 Terre |
| `recovery_inspect` | 检查批次、当前磁盘、备份、锁；支持 planId 查询和历史分页 |
| `recovery_restore` | 仅恢复用户选定且当前版本匹配的旧文件，先备份恢复前内容 |
| `recovery_reclaim_lock` | 使用检查得到的 token 显式回收已确认死亡的 MCP 锁；活/未知 owner、维护残留均拒绝 |

先读取工程并形成草案。写入前，客户端必须通过正常用户交互取得**本次明确答复**：同工程所有编辑页已经成功保存并离开。然后以 `decision=saved-and-editors-closed` 和用户原始答复建立会话；未答复、尚未保存或保存失败时不能代填确认。`userAttested` 只是声明记录，不能证明所有 buffer 已保存；Server 无法验证声明确实来自人类。旧答复不能用于重启后的新会话。

会话默认 5 分钟，绑定连接、工程和精确目标范围。交接后重新生成方案，确认改动后应用并回读，最后结束会话。遇到部分完成或结果不确定时，先用 `recovery_inspect` 核对磁盘并处理相关锁警告。确认可继续编辑后，用户再重新打开 Terre 编辑页预览或打包。`webgal_status.writable=false` 表示没有不带会话的全局写权限。是否启用写入工具见 `writeToolsEnabled`。

路径和操作约定：

- 会话/恢复的 `paths` 为工程相对路径，例如 `game/scene/start.txt`、`game/config.txt`。
- `create_scene` / `edit_scene` 的 path 相对于 `game/scene`；创建内容由 text 提供，编辑使用 expectedRevision 及基于原文的 UTF-16 半开范围 `{start,end,text}`，不计文件头 BOM。编辑按原文 offset 排序、互不重叠，不切断 emoji。
- `import_asset` 的 path 相对于对应 kind 目录，使用 sourceId、sourcePath、expectedSourceRevision；素材先提交，场景/配置随后。新场景/素材不覆盖，父目录必须已存在。
- `edit_config` 使用 `game/config.txt` 的 `expectedRevision` 和 `{key,value}` 更新。可以修改已识别的字段（例如 `Game_name`、`Description`、`Title_img`）或在格式明确时追加这些字段；其他字段和注释原样保留。目标字段重复、格式不明确或值不受支持时会拒绝写入。
- 方案提供原始 hash、有界前后文本和实际修改处 diff，截断明确标记。静态诊断会考虑本批次新增文件；它不证明游戏最终能运行。
- 场景、配置和其他素材上限为每文件 1 MiB，使用原有缓冲写入的部分每批最多 4 MiB。背景图和 BGM 超过 1 MiB 时走流式导入，单文件最多 16 MiB，流式部分每批最多 32 MiB。两类额度分别计算，整个批次最多 32 项。
- 流式计划只记录来源 ID、相对路径、大小和版本。应用时重新计算来源与暂存文件的 SHA-256，验证后以仅新建方式发布。素材原样复制，不下载、不转码。文本编辑最多 256 个范围/操作。

冲突时不提供 force。failed、partial、uncertain 结果带 `isError=true` 和批次状态，必须检查实际磁盘后再决定，不能自动重试覆盖；complete 也可能带锁释放警告。多文件不具备原子性，hash 与外部写入之间仍有竞争窗口。

保留 planId：回执丢失或进程重启后，可用 `recovery_inspect` 的 projectId + planId 查到已完成或未完成批次，不需要旧会话；旧会话不能恢复写权限。无过滤时仅发现未完成批次，`includeCompleted=true` 可查历史，分页使用 offset/limit。恢复必须有新鲜交接及用户选择，拒绝后来的人工修改，不删除新建文件或备份。崩溃维护 guard 和 staging 残留需操作者核对处理，不自动清除；手动打包前先检查残留。

流式素材的恢复报告还列出 `sourceBytes`、`stagingBytes` 和 `stagingVerified`。计划内容是否已发布看 `diskState`，暂存是否残留看 `stagingPresent`。出现空间不足或中断时，先根据这两处确认磁盘状态再决定是否重做。

## Live2D 模型与演出

同一个角色的每套模型各用自己的入口。把动作和表情分开选，即使它们同名。以 WebGAL 4.6.7 为例，`-motion=Tap` 播放组内第一个成员；要选另一个成员，在游戏副本登记单独的动作组，并保留该成员的声音。磁盘上额外的表情文件也要先登记，随后才能用登记名调用。两类登记都应出现在可审阅的导入草案中。

1. **发现和检查模型。** 用 `live2d_model_discover` 提供 `location` 与可选的相对 `directory`，按 `modelPath` 排序分页。候选会区分 Cubism 2 `model.json`、Cubism 3 `.model3.json` 和无法确认的入口。再用返回的 `modelPath/rootPath` 调用 `live2d_model_inspect`。`rootPath` 是依赖解析边界，可保留素材包内跨目录引用，同时拒绝越界读取。返回依赖路径相对模型目录，`counts` 是完整计数，数组超过报告上限时用 `live2d_model_entries` 取全量。
2. **分页取可调用项。** `live2d_model_entries` 接受 `kind`（`motion`、`expression`、`dependency`）、`prefix`、`offset`、`limit` 和 `expectedRevision`。前页的 `revision` 可传给下一页防止入口清单变化。动作项含 `motionGroup/motionIndex/sound`，表情项区分 `registered/unregistered`。每个动作或表情文件都有 SHA-256 `fingerprint`，manifest 没变但动作文件被替换时仍能触发已登记播放结果的复核；依赖项指纹为 `null`。源码桥接可调用 `snapshotLive2dCatalog(config, location)` 一次取得 `{ report, items }`。
3. **审阅导入。** `live2d_import_plan({ projectId: "my-game", sourceId: "assets", modelPath: "hero/hero.model3.json", targetDirectory: "hero" })` 返回草案。核对 `paths`、文件大小和 SHA-256、`bundleRevision` 与 `blockingIssues`。可用 `extraPaths` 指定相对于模型目录的额外模型、图片或音频文件。模型包最多 32 个文件、32 MiB，单文件最多 16 MiB。目标在现有 `game/figure` 下。curated 草案把 `.chara`、`.mtn_exp` 等点号目录转换为 `_chara`、`_mtn_exp`，同步重写 Moc、贴图、动作、表情和 Sound 引用，并用 `gameEntry` 给出入口创建/更新的前后 revision、动作组成员、表情和资源引用变化。discover 识别出的自定义 JSON 入口会在同一相对目录归一为 `model.json`；标准 `model.json` 和 `.model3.json` 名称保持原样。正式计划内部保存来源路径到游戏副本路径的 `sourceMappings`。
4. **交接后应用。** 在 Terre 保存并关闭工程的全部编辑页，明确交接草案中的精确 `paths`。再次调用导入计划，补上 `sessionId` 和 `expectedBundleRevision`。审阅正式计划后另行确认应用，再调用 `change_apply` 和 `write_session_end`。应用模型包在 Windows 上需要安装在标准位置的 PowerShell 7，在 Linux 上需要 Python 3 与支持 `renameat2(RENAME_NOREPLACE)` 的内核/文件系统，用于以不覆盖方式发布目录并保留已占用的名称。模型入口最后发布。中断时用 `recovery_inspect` 查看 `modelBundle`、`directories`、各文件的 `diskState` 和暂存信息。若某个目录留下暂存，目录记录的 `stagingPath` 会列出它相对于工程根目录的路径。重试前先确认现场；依赖批次已部分写入时，用原 `bundleRevision`、原批次 `batchIndex` 和失败计划 `previousPlanId` 重新审阅并续跑。
5. **编排演出。** 用 `scene_read` 找到确切对白和立绘上下文，根据模型检查结果选动作组和表情。用 `scene_validate` 检查完整候选文本，再用 `change_plan` 审阅该段修改。动作和表情更新时保留原立绘 ID、站位和其他必要参数。用户交接、确认应用并交回后，在 Terre 重新打开场景并预览。

`scene_validate` 返回 `live2dIssues`，`project_scan` 在每个场景下列出同一组诊断，包含行号、模型入口和可安全显示的依赖或参数。静态分析使用 WebGAL 4.6.7 的动作组和表情名称规则。实际渲染、动作混合和导出由 Terre 验证。Cubism 运行库由使用者按 [WebGAL 文档](https://docs.openwebgal.com/live2D.html) 配置。

### 按剧情导入和补项

例如，素材源 `models` 下有 `haru/runtime/haru.model3.json`。下面的只读草案选择 Tap 的第二个成员，同时给已有文件 Smile 补登记。先用检查结果核对实际文件名；`memberIndex` 从 0 开始。

```json
{
  "projectId": "my-game",
  "sourceId": "models",
  "rootPath": "haru",
  "modelPath": "haru/runtime/haru.model3.json",
  "targetDirectory": "haru-stage",
  "mode": "curated",
  "motions": [{"name": "Tap", "memberIndex": 1, "outputName": "Tap_2"}],
  "expressions": [{"name": "Smile", "file": "expressions/Smile.exp3.json"}]
}
```

后续补动作沿用相同的 `targetDirectory`。审阅资源清单、游戏入口的新增登记以及返回的实际调用名。需要分批时，每批分别审阅、交接、应用并读回；最终入口发布成功后才把模型写进场景。例如需要边鞠躬边哭时，在同一个 `changeFigure` 上设置 `-motion` 和 `-expression`。表情单独变化时保留相同的模型路径、figure ID 和槽位，只指定这次要换的表情。
