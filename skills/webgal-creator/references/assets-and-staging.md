# Assets and staging

## Asset readiness after script review

Once the user approves the Markdown, derive an asset list from that exact story revision. Cover backgrounds and cover art, important characters' portraits and expressions, BGM, ambience, one-shot sounds, and visual effects that affect staging. For each item, state what it is, where or how it will be used, and whether it is required or optional. A cue may be intentionally absent when the story calls for it.

把剧本已标出的反应和回场用到的表情一并列入素材需求。普通 PNG 优先选同服装、同姿势且留边对齐的差分；使用 Live2D 时核对当前模型已登记的表情。缺少合适表情时，按本节的素材缺口流程说明影响和可用备选。叙事明确要求的暂时退场按演出记录执行。

Before looking for assets or starting related subagents, confirm the permitted sources. Ask about generation or external search only if relevant to an unresolved need or requested by the user. Put the asset list in the first message asking about sources. Invite the user to mark which items they will provide and which may be selected from `res` when both are available. Keep this as one grouped request. Use any source choices the user already made for the items they cover. With an exclusive root such as `res`, keep selection, reads for discovery, and delegated searches inside that root. Check resolved paths and exclude links that lead outside. Keep derivatives in authorized staging and derive them only from permitted assets when the user allows processing. If the allowed source lacks an item, explain the gap and offer authorized alternatives or a scope decision.

**共享素材库选材。** 剧本确认前只处理文章和选角。确认后，有库根就直接调用同级 `webgal-librarian/scripts/library.py`。角色分组使用**演员的素材名**，例如「林由小仓朝日出演、服装08、姿态01，平静地说」可直接执行：

```powershell
python "$tool" search "$lib" --type 立绘 --group 小仓朝日 --require 服装08 --require 姿态01 --term 平静 --fallback 安静
```

每项需求一次命令，把近义词和备用词合在一起；返回结果含原样路径和表情描述，有合适项即选。仅用户主动要求查看更多时翻页。不要先列素材目录、读 INDEX 或分册、遍历偏移量、循环调用 search/show。缺少依据才按路径 show 最终入围项。最多两轮（含脚本自动备用查询），不足则报告缺口。按[项目交接约定](../../webgal-librarian/references/project-handoff.md)复用或绑定库根并记下选材。来源与授权各自只在用户明确要求时读取。

When project assets are within scope, use `asset_list` for the relevant pages. Inspect shortlisted unfamiliar images and sounds for actual fit. A file name, a starter asset, or a successful reference check alone does not establish suitability or usage rights.

Before building executable WebGAL candidates, give the user a compact grouped summary of what is usable, what is missing or unsuitable, and the resulting effect on the game. If the inventory covers the approved story, summarize reuse and proceed. When a gap lacks a decision, offer one bundled choice for all unresolved items:

1. **Prepare assets automatically.** Use available authorized tools within the confirmed source scope. Generate or search externally only when that scope permits it. Aim for a coherent visual style and appropriate audio. Show the planned source or method, such as generated character art or a licensed recording for the rain cue.
2. **Use assets the user provides.** List what to supply and what it will be used for. Continue when the files are usable and authorized.
3. **Make a simplified placeholder build.** Specify the proposed simplifications in the option itself, including which backgrounds would be placeholders, which characters would have reduced or absent portraits, and which sounds or effects would be omitted or conveyed another way.

An existing specific choice covers the same missing assets without another question. With prior authorization for automatic preparation, proceed using suitable available tools within that scope, then summarize the assets prepared and any unresolved gaps. A specific request for a placeholder build counts as the choice for the simplifications it covers. Still disclose them before building. Once coverage is resolved, summarize the result and move on. Ask again only for a new decision, a changed scope, or a review the user requested. A request to keep questions brief, Markdown approval, and formal write approval do not authorize omissions or replace an asset decision.

If an allowed tool is unavailable, fails, or cannot provide a suitable licensed result, tell the user which items remain and what they will notice. Try another suitable route under the existing authorization when available. Otherwise offer the user concrete next steps such as supplying a file, authorizing a new route, or accepting a specific simplification. Stop before candidate generation while a needed asset has neither a suitable source nor an explicitly accepted fallback. In particular, omitted expected portraits, simple backgrounds used as stand-ins, and silence in place of staged audio require disclosure and authorization. Automatic preparation authorizes the work, while a degraded result requires a choice that specifically covers it.

Keep the reviewed story revision, grouped asset decision, coverage, and any accepted fallbacks in private staging so a new session can distinguish a deliberate placeholder from an unresolved gap. Record each prepared asset's use, library-relative path or preparation method, treatment, target-relative path, and SHA‑256. For shared-library selection persist the project handoff. Only read and record the catalog's source or license field when the user explicitly requests that specific condition. Check requested conditions before including the asset; the user's allowed folder bounds searches without requesting metadata. Obtain any needed authorization for cost, external handling of private material, character depiction changes, and broader rights before acting.

## Prepare files and cues

Prepare new files in the registered asset source outside the game. Inspect exact file hashes with `asset_source_inspect` and include the revision in the proposed `import_asset` operation in `change_plan`. Use new target names and known existing parent directories. Reuse verified identical assets by reference. Plan licensed cover/background imports and supported title/config fields together with `edit_config` based on `project_inspect.configRevision`. The draft references staged assets; game imports take effect only through `change_apply`, after the Terre handoff, formal plan, and separate user approval in that order. Run the [batch preflight](sync-and-handoff.md#batch-preflight) before planning and validate each accepted batch.

Plan music, one-shot effects, and sustained ambience separately. For a sustained cue, record where it starts, what continues across scenes, and where it stops or fades. Where an in-engine fade is unavailable, use a tested, compatible staged fade asset if needed. Inspect audio transitions with a real browser and use playback and source levels to judge mixing. A playback probe alone cannot establish acceptable listening quality. If a cue needs a fallback, handle silence or narration at the asset readiness gate.

## Presentation quality review

Review presentation against the approved Markdown and asset decisions during the [saved Chrome check](acceptance.md#chrome-playthrough-and-evidence). Reuse any screenshots and playback observations from the selected scenes or cues. Report effects outside the sampled scope as unverified when relevant. Inspect presentation separately from the static scan.

- 抽查重要角色的在场状态与剧本要求的表情。对本轮涉及的反应、焦点切换和回场，按[画面抽查](../../webgal-staging/references/visual-validation.md#反应与焦点切换)核对触发时机、退场和回场构图，标记未抽查或延后的效果。
- Check that the speaker label clears when narration resumes.
- Identify any background or cover that remains a placeholder. Compare character art and backgrounds for fit in style, scale, and lighting. Explicitly report observed mismatches at delivery, including when the individual images were already accepted for a test build.
- Check whether music, ambience, and sounds suit their moments. Identify missing cues, and when continuous audio is in the selected scope, check the relevant transition, loop, or stop and fade. Say which audio aspects were actually observed.
- Compare the story's key staging directions with the result. Note effects left unfinished, simplified into narration, or skipped.

Include a compact quality checklist in the delivery message. Cover portraits and expressions, background placeholders, music and ambience, consistency between character art and backgrounds, and unfinished staging. Give each item a brief verdict (ready, approved simplification, gap, or unverified). When the styles differ, name the visible difference explicitly. Name the affected scene or beat for material gaps and recommend the highest-value improvement. Wait until the user asks to start another revision before requesting new asset decisions or write authorization. When later asked what to improve, revisit this comparison and prioritize basic asset and staging gaps ahead of optional polish when they have the larger effect.
