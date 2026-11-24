# 素材分册 v2（含 Live2D）

库根的 UTF-8 `INDEX.md` 含格式标记 `<!-- webgal-librarian v2 -->` 和五个稳定入口。立绘通常在 `catalog/立绘/<角色>.md`；Live2D 在 `catalog/Live2D/<角色>.md`；背景、BGM、音效默认在各自类别的 `_通用.md`，也可按已确认的素材包自定义分组。目录名称为检索分组。扫描从已知类型目录识别媒体；角色名由目录与重复目录名或文件名前缀相互印证。其他素材留待决定。素材原文件夹和命名不受分册影响。

每个分册以以下两行和中间空行开头。路径以库根为起点，使用原样拼写和正斜线。

```markdown
# WebGAL 素材分册

<!-- webgal-librarian book v2 -->

## BGM/quiet evening.ogg
- 名称: 晚自习之后
- 类型: BGM
- 描述: 适合空教室里的道别
- 标签: 安静、离别、放学后
- 来源: 未知
- 授权: 未知

这里可以保留手写备注。
```

每条记录有六个单行字段。类型与分册目录相符。同一库内相对路径唯一。已收录项可用 `assign` 调整类型或分组，连同手写备注一并移动。两册调整中断时，`recover "$lib"` 检查并续写；如遇并行手改先核对冲突。扫描仅向相应分册追加新记录。脚本按分册原子写入并检查同时编辑，异常中断后重扫可补齐剩余记录。已有写锁时先核实写入者和文件状态。同名不同路径分别处理；消失的素材保留条目，原路径恢复后重新参与查询。库根以外的文件和目录链接不参与查询。

## Live2D

`catalog/Live2D/<角色>.md` 每行表示一个可调用动作、已登记/未登记表情。动作引用为 `<模型入口>#motion/<URL 编码调用名>/<motionIndex>`，稳定身份由 `(modelPath, "motion", name, motionIndex)` 组成；同一动作文件可服务同一组的多个成员，各成员分别保留绑定声音并独立检索。已登记表情引用为 `<模型入口>#expression/<URL 编码调用名>`，稳定身份由 `(modelPath, "expression", name)` 组成，入口登记改为另一文件时沿用原记录。未登记 loose 表情引用为 `<模型入口>#expression/<URL 编码调用名>/<文件路径摘要>`，稳定身份额外包含 `path`，避免多个同名候选互相覆盖。所有 `path` 保持相对模型目录的原样引用，状态机另存于 `catalog/Live2D/.webgal-live2d.json`，该文件由 CLI 维护，不手改。

模型元数据保存角色、模型名、格式、入口 revision、默认前缀、counts、issues，以及 MCP 的 `sourceId/sourceModelPath/sourceRootPath`。条目保存类型、调用名、motionGroup/motionIndex、文件路径、文件 SHA-256、登记和可用状态。`rootRelativePath` 是 bridge 已规范到库根的真实位置，用于与普通素材隔离；`path`、`sound` 仍相对模型目录。模型纹理、motion、expression、动作绑定声音及全部 dependency 文件不会自动生成普通素材行；即使以前手工收录过，也不会进入普通搜索结果。

入库校验要求 `model` 与 `entryPage.modelPath/revision` 一致。`rootPath`、`format` 和 `counts` 在两侧同时提供且归一化后不同会拒绝整页；`modelPath` 越出选定的 `rootPath` 也会拒绝。为兼容旧输入，这些 additive 字段允许只出现在 `model` 或 `entryPage` 一侧；两侧都缺失时分别使用空根、`unknown` 和空 counts。counts 值须为非负整数。

一次同步是一份完整快照。分页必须从 offset 0 连续覆盖 `total`，最后一页 `nextOffset` 为 null。中途页只暂存在状态文件，不写入分册，也不影响已有条目。新 `scanId` 从 offset 0 可安全重启未完成扫描。只有完整快照提升后，旧快照未出现的条目才标 `stale`。入口 revision 变化或动作/表情文件 SHA-256 变化会把沿用条目标为待复核。缺失、失效、未完成和 unverified 条目保留记录但不作为默认候选。

每个动作或表情可以有且只有一个最近一次播放观察。`verify-live2d` 只在真实预览后使用，先重新计算动作/表情文件字节 SHA-256，再与入库快照匹配；成功后原子写入 `observation`、`fingerprint`、`revision`、`scope` 和 UTC `verifiedAt`，并清除该条目的 `needsReview`。验证 SHA 范围只有动作/表情文件与模型入口 revision，不含 moc、贴图、物理或其他依赖，搜索和 `show` 都会明示该范围，不能把它表述为整模型视觉复检。文件在入库后被改动但尚未重扫时，验证会失败并把条目标为待复核。重扫不会删除旧观察，手改描述、标签和块外备注也继续保留；当文件 SHA-256 或入口 revision 与观察绑定的值不同时，`show` 返回「待复核」，重新预览并验证后才返回「已预览」。从未验证的条目返回「未预览」。
