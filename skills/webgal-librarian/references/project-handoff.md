# Creator 与 Editor 共用的本机选材记录

从 Creator 或 Editor 安装目录的同级目录定位 webgal-librarian。用安装的 Librarian 的 `scripts/project.py`。使用 MCP 注册的同一个 projectId；命令中的各路径各自作为一个参数。记录保存在当前用户主目录下的 `.webgal-librarian/projects/`，目录名由 projectId 派生。

- `root <projectId>` 只返回项目的库根。首次需要共享素材而记录为空时，沿用用户在当前任务给的库位置；仍未知才问一次。用 `bind <projectId> "<库根>"` 绑定已建的库。
- Creator 确定某个用途和导入目标后，执行 `remember <projectId> --scene "game/scene/start.txt" --cue "<角色/figure ID 或 bg、bgm、独立音效用途>" --path "<库内相对路径>" --target "<工程内目标路径>"`。单个角色的默认立绘直接以角色名作为 cue（例如 `林`）。区分同角色多个演出点时，在角色名之后追加片段标识。重复需求复用已选路径。
- Live2D 导入后 readback 若生成 Terre game alias，remember 时追加 `--game-selector "<readback 后实际调用名>"`。示例为 `--game-selector "Tap_2"`。MCP 原名仍保存在 `Live2D.调用名`，实际工程名另存为 `Live2D.工程调用名`；未指定时后者不出现，旧记录无需迁移。Creator、Editor 编排 Terre 时优先使用工程调用名，展示来源时仍可报告原名。
- Editor 用 `recall <projectId> --scene "<工程内场景路径>" --cue "<同一用途>"` 取出库根、原路径与工程目标；可按当前保存的工程素材反查（`--target`）。记录是选材依据，应用与否及当前素材以实际保存场景为准。只传场景时返回用途总数与最多 5 个 cue 名。无记录的手工工程也可单独绑定库。
- 搜索使用同一安装的 `library.py search`，复核使用 `show`。仅当用户明确要求相应字段时才开启来源或授权；项目记录本身只保存定位信息。素材原件移走后提示缺口并按原需求重新查找。

## Live2D 选材

- Live2D 的动作和表情使用复合 `路径`，不要拆成单个纹理或动作文件，也不要把同名动作和表情互相替代。先按角色的模型入口与默认前缀查询，再用 `--kind motion|expression` 指定调用类型。
- `remember` 除库内复合引用和工程目标外，还会保存模型入口、入口 revision、模型名、动作/表情种类、调用名、动作成员、默认前缀、登记/可用状态、预览状态、验证范围以及可用的 MCP source 定位。验证范围明确只覆盖动作/表情文件 SHA-256 与模型入口 revision，Creator 和 Editor 不能把它转述为 moc、贴图或整模型视觉复检。该记录让新对话中的 Editor 找回同一模型和同一调用项。
- `recall` 返回的 `Live2D` 对象是选材依据。可用状态只接受 `registered|unregistered`；missing、stale、invalid、unverified 或未完成扫描的条目不能写入交接记录，须重新同步并复核。
- 同一场景有多个 cue 指向同一 Live2D 工程目标时，`recall --target` 返回模型定位、关联用途总数和最多 5 条动作示例。指定 `--cue` 可取回该处的原名、工程调用名、成员与库内引用。
- 用户指定某个角色时沿用模型 `默认前缀`。只有用户明确要求跨角色时才清空前缀并展示实际调用名；原始名称、motionIndex 和绑定声音始终保留。
