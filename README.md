# webgal-mcp

在 Codex 或 DeepSeek Harness（DSH）中，直接用对话指示Agent制作和编辑 WebGAL 视觉小说。**Creator** 把故事改编成游戏，**Editor** 修改已有游戏，**Librarian** 帮你从素材库里找背景、立绘和音乐。

## 环境要求

- **制作或编辑游戏（Creator / Editor）**需要 Windows 或 Linux、Git、Node.js **24.x** 和 WebGAL Terre，客户端可选 Codex 或 DSH。
- **在 Linux 上导入 Live2D 模型包**还需要 Python 3，以及支持 `renameat2(RENAME_NOREPLACE)` 的内核和文件系统。
- **使用共享素材库**需要 Python **3.10 或更高版本**，包括 Creator 和 Editor 通过 Librarian 查找素材时。

下表列出本机验证时使用的 Windows 环境。

| 工具 | 本机版本 |
| --- | --- |
| Windows | Windows 11 25H2（64 位） |
| Codex | `0.167.0-alpha.4.1` |
| DeepSeek Harness（`dsh`） | `0.2.1-rc.5` |
| Git for Windows | `2.54.0.windows.1` |
| Node.js / npm | `24.9.0` / `11.6.0` |
| WebGAL Terre | `4.6.7.0` |
| Python | `3.12.10` |

## 快速上手


在 Codex 或 DSH 的对话中发送以下安装和检查请求：

```text
请从 https://github.com/yuri77521/webgal-mcp-public 安装 webgal-mcp，
并安装 webgal-creator、webgal-editor 和 webgal-librarian 三个 Skill。
请复用已有安装并保留现有配置。帮我以只读方式连接一个 Terre 测试工程，
读出开场第一句，让我确认选对了游戏。
```

整理图片和音频、查询已有分册，可以只安装 `webgal-librarian`。为 Live2D 新建分册还需要 MCP。[Codex 手动安装](docs/tool-reference.md#手动安装) · [单独安装 Librarian](docs/tool-reference.md#单独安装-librarian)

需要在游戏里安排 Live2D 角色出场、动作或表情时，再给 Creator 或 Editor 加装 [webgal-live2d](skills/webgal-live2d/SKILL.md)。普通立绘、对白和音乐编辑可直接使用基础 Skill。

使用 DSH手动安装时，可通过 `cordis.patch.yml` 配置 `webgal` MCP，先以只读模式连接测试工程。[DSH 接入指南](docs/deepseek-harness.md)

## 用 Creator Skill 把文章做成短篇

> 请用 webgal-creator Skill 把这篇文章改成一部短篇视觉小说。先给我看剧本，我确认后再选背景、立绘和音乐。

## 用 Editor 修改已有工程

> 请用 webgal-editor Skill 把车站场景里，小澪第二次说的「没事」改成「再陪我一下」，并在这句之前播放工程里已有的那首 BGM。

手工制作的 Terre 工程也可以直接修改。Editor 会先展示改动的位置；有多个可能时，会列出前后文让你选。之后也可以说「撤销刚才那次修改」。

**写入游戏前**，先看改动，再保存并关闭该工程的全部 Terre 编辑页。Editor 会重新核对内容，等你单独批准正式计划后才写入。[启用工程写入](docs/tool-reference.md#启用受控写入)

## 用 Librarian 管理共享素材库

> 请用 webgal-librarian Skill 扫描我的素材文件夹，保持目录原样，只建索引。帮我找一首适合「放学后在车站告别」的 BGM。

即使用静态立绘制作游戏，Librarian 也能为同一素材库里的 Live2D 模型建档。首次建档或重扫时连接 MCP 并登记模型所在目录，之后可以离线查询，例如「找这套冬装爱音的眨眼表情」。要把动作编排进游戏，再用 Editor 和可选的演出 Skill，例如「在这句台词之后让祥子鞠躬，保留当前站位」。[Live2D 模型与演出](docs/tool-reference.md#live2d-模型与演出)

建库后，从根目录的 `INDEX.md` 可以打开各类素材分册，手动补充描述和标签。立绘通常按角色分册。每次搜索最多向 agent 返回 5 个候选，合计不超过 2,000 字符。只有你明确询问来源、授权或指定相关条件时，对应字段才会进入对话。[分册格式](skills/webgal-librarian/references/index-format.md)

安装 Librarian 并为项目指定素材库后，Creator 会在你确认剧本后自动选材。之后即使另开对话，也可以直接对 Editor 说「把这句台词前的表情换得更犹豫一点，沿用同一套服装和姿态」，它会沿用该项目的库和选材记录。

[工具参考](docs/tool-reference.md) · [许可证：PolyForm Noncommercial 1.0.0](LICENSE)
