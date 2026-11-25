# OpenWebGAL 4.6.7 相容性

基线为 WebGAL 4.6.7 及同版 parser；分别核对 Terre 版本、具体游戏使用的引擎和模板。遇到新写法时，先查命令注册、处理函数及工程资产。「待实机」表示下列语义已核对，指定素材和模板下的画面仍需验证。

| 项目 | 状态与依据 |
| --- | --- |
| 静态图片差分 | **原版实机已验一例。** 4.6.7 默认 IMSS、1280×720、同画布 PNG：右槽的具名人物移动后换表情，肩点连续，另一人留在原位。不同留边、尺寸和切换中途仍待验。 `changeFigureDiff` 用 ID 或槽位找到在场图片，保留变换、层级和进退场设置。没有可替换对象或请求移除时回到普通换图逻辑。Live2D、Spine 的动作与表情走模型流程。[差分实现](https://github.com/OpenWebGAL/WebGAL/blob/4.6.7/packages/webgal/src/Core/gameScripts/changeFigureDiff.ts) |
| 位移、命名及临时动画 | **待实机。** 三类动画可选 current/default 基准；非并行命令会接管同目标。动画属性、帧格式、工程登记名都会影响结果。[变换参数](https://docs.openwebgal.com/script-reference/commands/setTransform.html) · [4.6.7 参数解析](https://github.com/OpenWebGAL/WebGAL/blob/4.6.7/packages/webgal/src/Core/util/getSentenceArg.ts) · [帧格式](https://github.com/OpenWebGAL/WebGAL/blob/4.6.7/packages/webgal/src/Core/Modules/animations.ts) |
| 进退场、硬切和清场 | **普通具名 PNG 随背景硬切已实测。** 版本、前置状态与首帧检查见[硬切配方](transitions-and-timing.md#普通-png-随背景硬切)。自定义进退场、粒子组合仍待实机。`setTransition` 记录设置，`pixiInit` 清除已登记的 Pixi 演出。[背景实现](https://github.com/OpenWebGAL/WebGAL/blob/4.6.7/packages/webgal/src/Core/gameScripts/changeBg/index.ts) · [转场设置](https://github.com/OpenWebGAL/WebGAL/blob/4.6.7/packages/webgal/src/Core/gameScripts/setTransition.ts) · [Pixi 清理](https://github.com/OpenWebGAL/WebGAL/blob/4.6.7/packages/webgal/src/Core/gameScripts/pixi/pixiInit.ts) |
| 整台取景、基础调色 | **待实机。** 原版有 `stage-main` 舞台容器和 `bg-main` 背景目标。变换字段包括 brightness、saturation。按目标轻调，观察人物肤色和背景边缘。[舞台](https://github.com/OpenWebGAL/WebGAL/blob/4.6.7/packages/webgal/src/Core/controller/stage/pixi/PixiController.ts) · [变换字段](https://github.com/OpenWebGAL/WebGAL/blob/4.6.7/packages/webgal/src/Core/Modules/stage/stageInterface.ts) |
| `setCamera`、`setLighting`、`setFilter` | **4.6.7 不适用作这些效果。** 前两项未注册，未知命令名可变成说话者并解析为 `say`。后一项有命令名，但处理函数返回空演出。[注册表](https://github.com/OpenWebGAL/WebGAL/blob/4.6.7/packages/parser/src/config/scriptConfig.ts) · [parser 回退](https://github.com/OpenWebGAL/WebGAL/blob/4.6.7/packages/parser/src/scriptParser/commandParser.ts) · [setFilter](https://github.com/OpenWebGAL/WebGAL/blob/4.6.7/packages/webgal/src/Core/gameScripts/setFilter.ts) |
| 交互正文分页 | **原版实机已验，范围为 4.6.7、默认 IMSS、1280×720、中文及中英混排样本。** 独立阅读页可手点，长段末字需在正常画面核对。其他字体与画幅待验。[文本框](https://github.com/OpenWebGAL/WebGAL/blob/4.6.7/packages/webgal/src/Stage/TextBox/IMSSTextbox.tsx) · [回想](https://github.com/OpenWebGAL/WebGAL/blob/4.6.7/packages/webgal/src/UI/Backlog/Backlog.tsx) |

配方升为「原版实机已验」时，写明引擎、模板、前置状态和实际看到的变化。只有解析结果、素材清单或第三方环境截图时，保留待验。
