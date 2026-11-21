# 在 DeepSeek Harness (`dsh`) 中使用 webgal-mcp

本页说明如何把 `webgal-mcp` 通过 `stdio` MCP 接入 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（CLI：`dsh`，内置 MCP 客户端插件 `@deepseek-ai/dsh-mcp-client`）。

接入后沿用与 Codex CLI 相同的全部安全边界：

- **默认只读。** 不传 `--state-root` 时仅开放 11 个只读工具。
- **受控写入必须人工交接。** 配置 `--state-root` 后，每批修改仍须先审阅草案、由用户在 WebGAL Terre 中保存并关闭该工程的全部编辑页、再明确交接与确认应用；`dsh` 的工具审批弹窗不能替代人工保存与关页交接。
- **所有路径使用绝对路径。** 为避免 `dsh` 的工作目录（`cwd`）或会话目录切换引起路径漂移，`--config` 与 `--state-root` 均须填写绝对路径。

> 以下配置格式依据 `@deepseek-ai/dsh-mcp-client` 公开文档整理。DeepSeek Harness 仍处于快速迭代阶段，如实际版本的界面入口、profile 路径或字段名有调整，请以本机 `dsh` 版本文档为准。

## 前置环境

1. 准备好 **Windows、Node.js 24、Git、DeepSeek Harness (`dsh`)** 和正在运行的 [WebGAL Terre](https://github.com/OpenWebGAL/WebGAL_Terre/releases)，并准备一个专用测试工程（下文沿用 `my-game` 作为工程 ID）。
2. 先按 [README 快速上手](../README.md#1-下载并构建) 完成构建并准备好本机 `webgal-mcp.local.json`：

```powershell
git clone https://github.com/yuri77521/webgal-mcp-public.git
cd webgal-mcp-public
npm ci
npm run build
```

如需验证 Live2D 模型整包导入，还需按 [工具参考](tool-reference.md#live2d-模型与演出) 在 Windows 标准位置安装 PowerShell 7（`C:\Program Files\PowerShell\7\pwsh.exe`）。

## 接入方式

下面提供两种配置方式，二选一即可。**推荐先以只读模式跑通，确认 `webgal_status` 正常后再开启 `--state-root`。**

### 方式 A：`dsh web` 图形界面（`Settings → MCP`）

启动 `dsh web` 后，打开设置中的 MCP 服务管理页（如 `Settings → MCP` 或 `Settings → Plugins → MCP`，视版本而定），新建一条 `stdio` 服务：

| 字段 | 只读模式（推荐先试） | 开启受控写入 |
| --- | --- | --- |
| `serverName` | `webgal` | `webgal` |
| `transport` | `stdio` | `stdio` |
| `command` | `node`（找不到时改填 `node.exe` 绝对路径） | `node`（或 `node.exe` 绝对路径） |
| `args` | `["C:/path/to/webgal-mcp-public/dist/cli.js", "--config", "C:/path/to/webgal-mcp-public/webgal-mcp.local.json"]` | 在只读参数末尾追加 `"--state-root", "C:/Games/webgal-mcp-state"` |

`--state-root` 指向的目录用于存放计划、批次日志和备份，必须位于所有游戏工程与素材来源目录之外，且不能包含它们。

### 方式 B：`cordis.patch.yml` 配置文件

适合配置文件管理或无 Web UI 场景。将下面片段合并进对应 profile 的 `cordis.patch.yml`（例如 `%USERPROFILE%\.dsh\profiles\web\cordis.patch.yml`），或全局 `%USERPROFILE%\.dsh\cordis.patch.yml`（具体路径随 `DSH_HOME` 变化）：

```yaml
- insert:
    - id: mcp-webgal
      name: '@deepseek-ai/dsh-mcp-client'
      config:
        serverName: webgal
        transport: stdio
        command: node
        args:
          - 'C:/path/to/webgal-mcp-public/dist/cli.js'
          - '--config'
          - 'C:/path/to/webgal-mcp-public/webgal-mcp.local.json'
          # 开启受控写入时取消下面两行注释（目录必须位于所有工程与素材来源之外）
          # - '--state-root'
          # - 'C:/Games/webgal-mcp-state'
        # 排查首次连接失败时可临时取消下一行注释，让启动阶段直接报出错误
        # failOnStartupError: true
```

> 注意：顶层的 `- insert:` 不可省略；省略会被 Cordis 当作覆盖已有条目而报错。

如需单次试用而不改写默认配置，可将上面内容保存为临时 YAML 文件并运行 `dsh web --patch <文件路径>`；修改持久配置后可用 `dsh --profile web --dump-config` 核对合并结果，再重启或等待热重载生效。

在 `webgal-mcp-public` 仓库根目录运行下面这段 PowerShell，可直接打印带当前仓库绝对路径的只读配置片段：

```powershell
$repo = (Get-Location).Path.Replace('\', '/')
@"
- insert:
    - id: mcp-webgal
      name: '@deepseek-ai/dsh-mcp-client'
      config:
        serverName: webgal
        transport: stdio
        command: node
        args:
          - '$repo/dist/cli.js'
          - '--config'
          - '$repo/webgal-mcp.local.json'
"@
```

## 工具命名与服务端 `instructions`

- **工具命名空间：** 配置 `serverName: webgal` 后，`dsh-mcp-client` 会把全部工具注册为 `mcp__webgal__<tool>`（例如 `mcp__webgal__webgal_status`、`mcp__webgal__scene_read`、`mcp__webgal__change_plan`）。`webgal-mcp` 的 21 个工具名仅包含小写字母、数字和下划线，加前缀后最长 34 个字符。
- **提示词写法：** 日常对话可直接写短名（如 `webgal_status`）。如果同时接了多个 MCP 服务或模型认错工具，直接写完整名称（如 `mcp__webgal__webgal_status`）。
- **服务端 `instructions`：** `webgal-mcp` 会在 MCP 握手阶段返回分模式（只读 / 写入）的精简 `instructions`（UTF-8 字节数不超过 2 KiB，远低于 `dsh-mcp-client` 默认 32,768 B 上限），`dsh` 会将其自动加入系统提示词，提醒模型先查 `webgal_status`、不臆测未读内容、写入前先出草案并等待人工保存关页交接、失败先调 `recovery_inspect`。

## 可直接复制给 DeepSeek Harness 的提示词

若配置中的工程 ID 不是 `my-game`，把下面的 `my-game` 替换成实际 ID。

### 1. 只读连接检查与读取开场

```text
请用 mcp__webgal__webgal_status 检查 my-game，告诉我本机文件能否读取、Terre 是否响应、工程映射是否一致，并给出下一步。如果本机文件可读，请用 scene_read 读 start.txt 的第一句对白；如果找不到 start.txt 或里面没有对白，请用 scene_list 列出候选并等我选。全程只读，不要臆测未读取的内容。
```

### 2. 导出前全工程扫描

```text
请用 project_scan 对 my-game 做只读扫描，汇总已检查的场景范围、确定缺失的本机素材或跳转目标，以及需要我在 Terre 预览确认的动态引用。如果 scope.nextStartAfter 存在，请继续分页扫描直到报告完整或说明停止原因。不要修改任何文件。
```

### 3. 受控修改一处对白（需已配置 `--state-root`）

1. **先看草案：**

   ```text
   请先用 webgal_status 确认 my-game 的 writeToolsEnabled 为 true 且 Terre 映射为 verified。然后用 change_plan 为 my-game 的 start.txt 起草一处修改，把第一句对白改成「欢迎来到试用工程！」，保留说话人和其余内容。如果无法确认哪句是对白，请先问我。现在只生成只读草案，不要建立写会话，等我亲自确认保存并关闭 Terre 编辑页后再交接。
   ```

2. **人工保存并交接：** 在 Terre 中保存工程并关闭该工程的全部编辑页，然后明确回复模型已经保存并关闭全部编辑页、授权交接 `game/scene/start.txt`，让模型用你的原话调用 `write_session_begin` 并重新生成可应用的计划。
3. **确认应用并交回：** 核对新计划只包含预期改动后，让模型记下 `planId`，调用 `change_apply` 并在完成后调用 `write_session_end`。收到交回提示后，再重新打开 Terre 编辑页并预览确认。

### 4. Live2D 模型检查与演出编排

```text
请在 my-game 的 start.txt 中找到「你怎么在这里？」这句对白。
用 live2d_model_inspect 查看 hero/hero.model3.json 的动作组与表情名，
从实际存在的选项中挑一个适合惊讶的动作和表情，在这句对白后加一段演出。
保留角色 ID、站位和其他参数。位置、角色或可用动作有歧义时先问我。
用 scene_validate 检查候选文本，再用 change_plan 给我看只读草案，等我确认。
```

## DeepSeek Harness 专属排查表

通用连接、Terre 映射、版本冲突与恢复排查见 [连接与试改排查](tool-reference.md#连接与试改排查)。以下为 `dsh` 特有现象：

| 看到什么 | 检查哪里 | 怎么重试 |
| --- | --- | --- |
| `dsh` 启动成功，但看不到任何 `mcp__webgal__*` 工具 | `dsh-mcp-client` 默认 `failOnStartupError: false`，首次连接失败不会阻断启动。检查 `cordis.patch.yml` 是否包含顶层 `- insert:`、是否运行过 `npm run build`，并用 `dsh --profile web --dump-config` 核对条目是否生效。 | 临时在配置中设置 `failOnStartupError: true` 查看具体报错；修正配置后重启 `dsh`，再调用 `mcp__webgal__webgal_status`。 |
| 报错找不到 `node` 或提示 Node 版本不兼容 | `webgal-mcp` 要求 Node.js 24（`>=24.0.0 <25`）；部分 Windows 环境下子进程 `PATH` 未包含 Node 24。 | 在命令行运行 `where.exe node` 与 `node -v` 核对版本，将配置中的 `command` 改为 Node 24 的 `node.exe` 绝对路径后重试。 |
| 报 `CONFIG_NOT_FOUND` 或 `--state-root` 位置异常 | `dsh` 启动子进程时的 `cwd` 可能与仓库目录不同（尤其开启会话目录相关选项时），相对路径会发生漂移。 | 将 `args` 中的 `dist/cli.js`、`--config` 和 `--state-root` 全部改为 Windows 绝对路径，重启后重试。 |
| 重启 `dsh`、编辑 `cordis.patch.yml` 热重载或断连重连后，写入报 `HANDOFF_REQUIRED` 或 `SESSION_MISMATCH` | `webgal-mcp` 将写会话绑定在单次 `stdio` 连接上，连接断开或重载会立即撤销旧会话，不允许继承旧写权限。 | 确认 Terre 编辑页仍处于已保存且关闭状态，重新向模型明确交接并生成新计划；若上一批已提交但回执丢失，可直接用 `recovery_inspect` 传入 `projectId` 和 `planId` 查询（无需旧会话）。 |
| 已经在 `dsh` 里点了“允许工具调用”，为什么仍不能直接写入 | `dsh` 的工具审批只授权客户端发起工具调用，不代表 WebGAL Terre 中未保存的编辑页已经落盘关闭。 | 按流程在 Terre 中手动保存并关闭该工程的全部编辑页，再明确文字回复交接。 |
| 导入 Live2D 模型包时在精简环境下报 `CREATE_ONLY_UNSUPPORTED` 或 `WRITE_FAILED` | `dsh-mcp-client` 会清洗 `stdio` 子进程继承的环境变量（默认仅移除名称含 `KEY`/`TOKEN`/`SECRET`/`PASSWORD` 的变量及 `DSH_*`，`ProgramFiles`/`SystemRoot` 通常会保留）；Live2D 目录发布需调用 Windows 标准位置的 PowerShell 7（`Program Files\PowerShell\7\pwsh.exe`）。`webgal-mcp` 另在缺少 `ProgramFiles`/`SystemRoot` 时提供防御性默认回退（`C:\Program Files`、`C:\Windows`），若本机安装路径非默认盘符仍需显式传入。 | 确认已安装 PowerShell 7；如系统盘或安装目录非 `C:\`，在 `dsh` 的 `webgal` 配置 `env` 中显式补充 `ProgramFiles` 与 `SystemRoot`，重启后重试。 |

## 验证范围与真机验收清单

> 自动化契约测试与真人 `Windows + dsh + WebGAL Terre` 端到端验收分开记录，不混记。

### 已完成的自动化契约验证（Vitest）

仓库内 [test/dsh-compat.test.ts](../test/dsh-compat.test.ts) 使用 `@modelcontextprotocol/client` 与本地 Terre 契约桩，自动化覆盖了以下与 `dsh` 相关的协议和运行时行为：

- 只读与写入模式均返回非空、受控长度（`<= 2 KiB`，远低于 `dsh-mcp-client` 的 32,768 B 上限）且不含本机路径的 MCP `instructions`。
- 模拟 `dsh` `stdio` 探针（`initialize → listTools → 立即关闭`）不会创建或写入 `--state-root`、不留锁、`stderr` 为空且干净退出；随后正式拉起可正常读写。
- 全量 21 个工具的 JSON Schema 与元数据审计（顶层 `type: "object"`、`additionalProperties: false`、无 `$ref`/`$defs`、无不兼容正则、`mcp__webgal__*` 命名与注解准确）。
- 正常返回、业务错误和参数校验错误下，`content[0].text` 与 `structuredContent` 保持一致且不返回空 `content`。
- 模拟精简环境变量（`scrubbed env`，SDK 仍会合并其默认基础变量，因此为“精简”而非完全为空）与异地 `cwd` 启动读写正常，且验证 `directoryPublisherEnv` 在缺失 `ProgramFiles`/`SystemRoot` 时的安全回退。
- 模拟 `dsh` 重启/重连：断开连接后旧 `sessionId` 立即失效，且 `recovery_inspect` 仍可凭 `planId` 查到既有批次。

上述测试**仅证明协议与运行时契约**，不等同于真实 `Windows + dsh + DeepSeek 模型 + WebGAL Terre` 端到端验收。

### 给仓库 Owner 的真机手工验收清单（未执行项保持未勾选）

请仅在专用测试工程与可公开原创素材上执行，验收完成后填入实际环境与结果。

#### 验收环境记录

| 项目 | 实际版本 / 说明 |
| --- | --- |
| Windows 版本 | `待填写` |
| Node.js 版本 | `待填写（需 v24.x）` |
| `@deepseek-ai/dsh` / `@deepseek-ai/dsh-mcp-client` 版本 | `待填写` |
| 使用的 DeepSeek 模型 | `待填写` |
| WebGAL Terre 版本 | `待填写` |
| 接入方式（`Settings → MCP` / `cordis.patch.yml`） | `待填写` |

#### 1. 准备与配置核对

- [ ] 核对当前本机 `dsh` 版本的 `Settings → MCP` 界面入口与 `cordis.patch.yml` 路径/字段，确认与本文档一致（如有差异记入 PR 或更新文档）。
- [ ] 在 Windows + Node.js 24 下完成 `npm ci`、`npm run check`、`npm test` 全绿。
- [ ] 先以只读模式把 `webgal-mcp` 接入 `dsh`（使用绝对路径），确认 `dsh` 中可见 11 个 `mcp__webgal__*` 工具且无启动错误。

#### 2. 只读检查与 `project_scan`

- [ ] 用提示词 1 调用 `webgal_status` 检查运行中的 Terre 专用工程，确认 `projectFiles.readable: true`、`connectionStatus: responded`、`mappingStatus: verified`、`writeToolsEnabled: false`。
- [ ] 用 `scene_read` 读出 `start.txt` 开场对白，且磁盘工程文件无变化。
- [ ] 用提示词 2 调用 `project_scan`，确认能列出扫描范围及缺失/未验证引用，且磁盘工程文件无变化。

#### 3. 受控写入交接与 Terre 预览

- [ ] 在 `dsh` 的 `webgal` 启动参数追加独立绝对路径 `--state-root`，重启/重载后用 `webgal_status` 确认 `writeToolsEnabled: true` 且暴露 21 个工具。
- [ ] 用提示词 3 生成 `start.txt` 只读草案，确认模型未在人工交接前私自调用 `write_session_begin` 或 `change_apply`。
- [ ] 在 Terre 保存专用工程并关闭该工程的全部编辑页，明确文字回复模型交接；确认模型重新生成可应用计划并等待再次确认。
- [ ] 确认后记录 `planId`，执行 `change_apply` 与 `write_session_end`。
- [ ] 重新打开 Terre 编辑页，确认对白已更新并从 Terre 启动预览核对。

#### 4. 异常与重启/重载恢复

- [ ] 在写会话进行中重启 `dsh` 或触发配置重载，确认模型无法继续复用旧 `sessionId`（触发 `HANDOFF_REQUIRED` / `SESSION_MISMATCH`）。
- [ ] 在新连接中不建写会话，直接调用 `recovery_inspect` 传入刚才记录的 `planId`，确认能查到已完成批次状态。

#### 5. Live2D 检查（可选，需已准备测试模型）

- [ ] 使用提示词 4 调用 `live2d_model_inspect`、`scene_validate` 和 `change_plan`，确认 DeepSeek 模型能正确传入 `location` 与 `operations` 参数、无工具调用 400 或 schema 校验报错。
- [ ] 如已安装 PowerShell 7，在专用工程上验证一次 `live2d_import_plan` 草案与交接导入，确认精简环境变量下目录发布正常。
