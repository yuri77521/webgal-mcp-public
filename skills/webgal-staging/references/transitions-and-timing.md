# 转场与时序

先从旧场最后一个可读页推到新场第一个可读页。突然揭示可以硬切；让两幅画面短暂并存可以淡化；要表现时间断裂，则留出玩家确实能看见的黑场。黑底可能被旧人物、粒子或仍在运动的舞台覆盖。逐项决定保留、退出或恢复哪些对象，动作要落在对应的对白间隙。

## 普通 PNG 随背景硬切

**已实测**：OpenWebGAL 4.6.7、默认 IMSS、无自定义转场，雨幕和守夜人都是具名普通 PNG。给每张需在切点消失的图片在**入场时**登记 `-exitDuration=0`。4.6.7 处理 `changeFigure:none` 时会跳过动画参数登记。只在移除句补零，实测仍可在室内首帧看到旧人和雨丝。[changeFigure 实现](https://github.com/OpenWebGAL/WebGAL/blob/4.6.7/packages/webgal/src/Core/gameScripts/changeFigure.ts)

```webgal
changeFigure:rain.png -id=weather -exitDuration=0 -next;
changeFigure:porter.png -left -id=porter -exitDuration=0 -next;
守夜人:外面还在下雨。;
changeFigure:none -id=weather -next;
changeFigure:none -left -id=porter -next;
changeBg:room.png -duration=0 -exitDuration=0 -next;
:门关上了。;
```

末句由玩家手动翻过。抽查第一张发生变化的室内帧及室内落定后的缺席页。剧情需要人物回来时，在回场台词前重新用原 ID、预定槽位和素材入场，检查可见性、落点及天气是否仍已清除。透明度为零或移出屏幕只能证明暂时不可见。若入场句在可改范围外，指出需要上移到哪条入场句，并在交接中标明仍待解决的切点。命名动画、Live2D 和真正的天气粒子需各自核实。

## 其他动画与转场

| 需要做什么 | 原版 4.6.7 的选择 |
| --- | --- |
| 单段位移、缩放或调色 | `setTransform` 接一个目标变换。明确 target、终点和所需时长。当前与默认状态是不同的起点；需要时显式指定 `-transformFrom=current` 或 `-transformFrom=default`。 |
| 几个阶段连起来 | `setTempAnimation` 使用内联关键帧；`setAnimation` 引用工程已登记的动画名。先核实帧格式和首尾状态。旧数组的 `duration` 是各段时长，v2 对象的 `time` 是帧所在的时间点；相对变换和帧继承分别处理。 |
| 改进退场样式 | `setTransition` 更新目标设置。要让对象进出还需相应的背景或立绘命令。替换身份时旧设置可能被清理；检查实际生效的是哪一次进场或退场。 |
| 控制默认淡化 | `changeBg` 默认入场取 `duration`（省略为 1500 ms），`enterDuration` 可覆盖它；默认退场独立取 `exitDuration`（1500 ms）。普通立绘默认进场 200 ms、退场 160 ms。零是显式值。只给新背景写 `-duration=0`，仍须核对旧图退场、有名动画和在场立绘。 |

**推进与并行。** `-next` 把后句纳入当前推进；`-continue` 请求当前演出结束后继续，即使 AUTO 关闭也可能前进。需要玩家读完的正文保留停页。`-keep` 可让上述变换动画跨语句播放；它仍可能被同目标新的非并行动画打断。`-parallel` 可让同目标动画并行，给各轨分配不同属性，例如一轨写横移，另一轨写亮度。两轨都写位置时，合成一条轨或调整时序。演算终态可能早于屏幕上的动作结束，尤其要观察动画中途接招、点击跳过或换图时的画面。

**清理范围。** 换背景时分别检查旧人物、天气、舞台变换和调色。4.6.7 的 `pixiInit` 会清除已登记的 Pixi 演出；有多种效果需要保留时，先确认清理范围和重建顺序。围绕最容易出错的间隙从前一页起播，比较起点、变化中及落定后的第一句。
