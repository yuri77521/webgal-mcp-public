---
name: webgal-librarian
description: 管理可手改的 WebGAL 共享素材分册，按角色、场景或情绪查找背景、立绘、Live2D、BGM 和音效，供 Creator 和 Editor 复用。
---

# WebGAL Librarian

使用随 Skill 安装的 Python 3.10+ 标准库 CLI。下文 `$tool` 是 `scripts/library.py` 的绝对路径，`$lib` 是用户指定的库根。运行脚本即可；日常找图、盘点、交接都通过 CLI 完成。全量读取 Markdown、列出全目录、打印脚本源码会把无关数据带入上下文。

## 读取 Live2D 模型档案

1. 模型发现和检查使用 MCP；库根中已有模型入口时，用同目录的 `sync_live2d.py` 把完整分页快照一次写入，不手工转存 JSON。命令为 `python "$skill/scripts/sync_live2d.py" "$lib" --server "<dist/cli.js>" --config "<config>" --source "<sourceId>" --package "<source 内目录>" --entry "<source 内模型入口>" --character "<角色>" --model-name "<模型>" --prefix "<默认命名空间>"`。`--package`、`--entry` 都相对登记源；根位置分别写 `.` 和入口路径。Sakiko 使用 `--prefix sakiko/`，无命名空间的模型用空字符串。
2. 桥接只把 MCP 元数据送入库。原生动作纹理、动作、表情和绑定声音由 MCP 的 `rootRelativePath` 定位，排除在背景、立绘、BGM、音效候选之外。`live2d-ingest` 每次只消费一页；`scanId`、revision 或页序不连续时不得继续。扫描中断后直接重跑 `sync_live2d.py`，其新 `scanId` 会安全重启；旧条目在完整快照写入前继续可用，不必删除分册。
3. 入库后按硬条件搜索：`python "$tool" search "$lib" --type Live2D --group 祥子 --model school_winter-2023 --kind expression --term 哭泣 --term 犹豫`。`--kind` 取 `motion|expression`，`--status` 可取 `available|registered|unregistered|missing|invalid|unverified|stale|all`。给定 `--group` 或 `--model` 时自动使用该模型的默认前缀；用户明确要跨角色搜索时传 `--prefix ""`，其他前缀精确按大小写匹配调用名开头。仍遵守单次最多 5 项、2,000 字符和最多两轮。
4. 用返回的复合 `路径` 执行 `show "$lib" --path "<Live2D引用>"`。`预览状态` 明确区分「未预览」「已预览」「待复核」；待复核表示入口 revision 或动作/表情文件 SHA-256 已变化，必须重新预览。`验证范围` 表示只校验动作/表情文件 SHA-256 与模型入口 revision，不覆盖 moc、贴图、物理或其他依赖，不能据此宣称整模型视觉复检。结果为 `unregistered`、`missing`、`stale` 或 `unverified` 时另说明可用性缺口。普通 `show` 不输出 Markdown 备注、来源或授权；用户明确要求后才分别使用 `--source`/`--license`。MCP 定位只在 `show` 的 `MCP定位` 中返回。
5. 只有实际预览过动作或表情后才运行 `python "$tool" verify-live2d "$lib" "<Live2D引用>" --observation "<实际看见的效果>"`。观察应写可见或可听效果，例如「抬手后低头，眼角有泪光」，不要仅写「正常」。CLI 会重新计算当前动作/表情文件 SHA-256 并绑定当前模型入口 revision；文件与入库快照不一致时拒绝登记并标为待复核。重扫保留旧观察和分册手注，但文件或 revision 变化后状态回到待复核；重新预览并再次执行本命令才闭环。`已预览` 只表示上述文件与入口范围通过，不能外推为 moc、贴图或其他依赖也已复核。

## 按情境找素材

1. 将需求拆为硬条件（类型、角色、指定目录）与偏好（情绪、表情、姿势）。调用 `python "$tool" search "$lib" --type 立绘 --group 小仓朝日 --term 欲言 --term 犹豫 --term 微张嘴`。每个搜索词单独传入。需保留的服装或姿态用可重复的 `--require 服装08 --require 姿态01`。类型和分组可省略以跨册搜索；`--dir` 是相对于库根的精确目录范围。角色已知但库使用自定义分组时，核实候选身份，不能放宽用户指定角色。先用返回的描述或标签判断。只有文字依据不足或用户要求看图、试听时才打开入围素材。区分索引依据与实际观看、试听。
2. 一次最多 5 项、2,000 字符。用一个命令传入多个词；需要备用词时加可重复的 `--fallback`，脚本只在首轮零命中时再查一次。普通选材使用这一次调用，已有可靠候选便选定；确需放宽软条件时，每个需求总共至多两轮。无足够证据则说明缺口；用户主动翻查时用返回的「下一页」作为 `--offset`。单条原样路径与依据过长会计入「超限」。同一需求复用已选记录。已知路径用 `show "$lib" --path "<相对路径>"` 复核。
3. 默认搜索、复核、交接均只用普通字段。用户明确要求来源时才用 `search --source "<来源词>"` 或 `show --source`；要求授权时才用 `show --license` 核实入围项的完整授权。确切的授权字段值可用 `search --license "<完整值>"` 筛选。自由表述的许可条件须结合全文判断，包括否定、署名和例外；未知或无法证明符合时跳过。两个开关各自独立。限制某个文件夹用 `--dir`。普通搜索的所有重试均沿用这些字段边界。
4. 交接库根、原样相对路径、场景用途与匹配依据。Creator 和 Editor 的私有本地记录见[项目选材交接](references/project-handoff.md)。

## 接管、重扫与待决定项

- 首次接管已有素材夹先确认目录选择。「保留素材、文件名、标注」尚不能确定是否移动文件。用户明确说只建索引或保持目录原样，才运行 `scan "$lib" --layout-confirmed`。如要求看整理方案，先只读盘点，列出每个拟移动文件的原路径和新路径、冲突、配套文件和旧引用。等用户批准具体清单再移动；变化或冲突时停下。已有分册涉及移动时保留旧条目和完整手写注记，新记录由用户核实归属。
- 新建空库用 `init "$lib"`，重扫已接管库用 `scan "$lib"`。先归组有依据的素材，完成后汇总待决定项。需要明细时用 `stats "$lib" --list pending --offset 0`，每页 10 条；缺失明细用 `--list missing`。用户可以选择已有组、自定组、或继续搁置。确认后用 `assign "$lib" "<相对路径>" --type 立绘 --group "<组名>"` 归组。搁置的文件保持原位，查询时跳过。
- 盘点用 `stats "$lib"`，可按 `--type` 或 `--group` 缩小已收录统计。维护分册、手工补注和冲突处理见[索引约定](references/index-format.md)。旧单文件 v1 库会提示格式不同并保留原件。

## 按自然语言补注

通过 search / show 确认唯一目标。同名无法消歧时展示候选路径。用 `tag "$lib" "<相对路径>" "<标签>"` 或 `set "$lib" "<相对路径>" "<字段>" "<值>"` 保存；仅按用户要求维护来源或授权，保留原文限制。用 show 核对所改字段。Live2D 也使用复合引用维护描述和标签，重新同步时保留这些字段及块外手写备注。描述可根据用户说明、已查看内容或已有标注完善。
