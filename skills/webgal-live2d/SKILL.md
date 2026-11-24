---
name: webgal-live2d
description: Stage a Live2D figure in a WebGAL scene when the current cue introduces a model or changes its entrance, framing, motion or expression. Use with Creator or Editor. Model cataloguing and library-only lookups belong to webgal-librarian.
---

# WebGAL Live2D

For a reviewed script, use Creator's approved casting and fragment. For an existing game, use Editor's saved scene, target figure and dialogue gap. If invoked directly, follow the corresponding [Creator](../webgal-creator/SKILL.md) or [Editor](../webgal-editor/SKILL.md) workflow for review, handoff and writing. A new article goes through Creator's Markdown review before model selection.

## Resolve the model and its performance

- Prefer the verified model already in the project. Read its actual entry with `live2d_model_inspect`. For a nested entry, pass `modelPath` relative to `game/figure` and `location.rootPath` equal to the imported package's `targetDirectory`. For example, `hero/outfit/model.json` can use motions in `hero/motions`.
- When using a shared library, let [Librarian](../webgal-librarian/references/project-handoff.md#live2d-选材) resolve the actor, outfit and exact model. Look up motions and expressions separately, even when they have the same name. Include the idle group needed for entrances or returns. Use the saved project's registered names in the cue, including a namespaced idle when applicable.
- If a needed item exists only in the permitted source, inspect the source entry and the connected MCP's supported formats. Draft a selective `live2d_import_plan` for the missing resources, reusing the same target directory for an existing game copy. Review the entry diff, member aliases, expression registrations and attached sounds. Use model bundle limits for dependencies. Follow the caller's Terre handoff and formal approval for each batch, verify the dependency batches before publishing the entry, then reinspect the saved entry and selected names before preparing the dependent scene edit. Record the applied game entry and actual selector by scene and figure ID in the library handoff.
- Check that the model has a compatible Cubism runtime. If the model or action is unavailable, explain the visible gap. Use a static portrait, expression variant or narration when the user has approved that fallback.

## Place the cue

**Creator.** Keep the game model path stable across scenes. Place entrances, reactions and exits at the approved dialogue beats. Set the figure's ID and slot, calibrate upper-body framing for each actor, and preserve the active position, scale and other transforms on updates.

**Editor.** Trace the saved figure and the complete spoken line. To react after an utterance, insert the cue before the following line. Run `node <webgal-editor>/scripts/local-edit.mjs` with `mode: "live2d"`, the verified `projectId`, original `scene_read` snapshot as `scene`, 1-based `firstLine`, exact dialogue `before`, and `figure: { modelPath, slot, id }`. Omit `id` for an anonymous figure. Supply the verified `motion`, `expression`, or both for a simultaneous reaction. The helper repeats the model, ID and slot. For an active custom transform, conditional branch or other required arguments, use Editor's ordinary draft mode and retain those values in the cue.

Validate the exact candidate with `scene_validate` and compare the `change_plan` after revision with the reviewed candidate. Follow the caller's preview scope. At the selected dialogue, check the actor in its actual slot, framing and expression on both sides of the change. For entrances and re-entry, check the intended single- or two-character composition and idle when visible. A preloaded model or motion request alone cannot confirm playback.
