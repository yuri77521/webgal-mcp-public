# Synchronization, handoff, and recovery

## Private map and project binding

Use schema version 1 in `script-map.json`. Map the selected MCP project ID plus the verified official preview URL. Confirm the same target and saved baselines upon reopening, particularly if configuration or paths changed. If the identity cannot be established, continue read-only and ask the user to identify the intended project. Keep one workflow writer per creation directory. Resume its pending entry before planning another write.

```text
schemaVersion: 1
project: { id, previewUrl }
scenes:
  S001:
    path: start.txt
    verifiedRevision: <latest checked scene bytes SHA-256>
    fragments:
      F001:
        markdown: <last approved and synchronized fragment body>
        webgal: <exact saved generated commands>
        left: <saved text directly before webgal, or empty>
        right: <saved text directly after webgal, or empty>
        state: synced | pending-terre
pending: null | <batch verification record>
```

The two hashes serve different purposes. `verifiedRevision` tracks the latest checked file. Each fragment retains its own last synchronized content, including when a different fragment in that same file was updated. Persist enough exact context to locate only what you own. Scope paths and the root of the game and asset source are distinct from the private work directory. Keep the map and its scene text local.

## Prepare local edits from saved text

1. Review `story.md`, the synchronized fragments and the saved `scene_read` snapshot together. Determine which commands belong to the affected fragment and whether context from another cue or scene is required (figure IDs, ambience, jumps, etc.). Unknown commands stay byte-for-byte.
2. If Terre changed unrelated material, preserve it and mark the affected map fragments `pending-terre`; keep their old Markdown and WebGAL baselines. Use the old known context to prove the target is still unique. If a hand edit touched one context anchor, independently verify and narrow the recorded context or stop for clarification. When both sides changed the same fragment, a dependency changed, the target was deleted, or attribution is uncertain, show the three versions and obtain the user's choice. Treat a partially owned reordered span as a conflict, and use exact anchored inserts or removals when ownership is clear.
3. Invoke `node <skill>/scripts/scene-patch.mjs` with UTF-8 JSON via stdin. `validate-story` accepts `{ "mode": "validate-story", "storyText": "..." }` and returns scene/fragment ID lists. `patch` takes the reviewed `storyText`, its `sceneId`, the original `scene_read` object as `scene`, the existing version 1 `script-map.json` contents as `scriptMap`, and `changes` as below. Use `scene_read` from the verified project recorded in the map. The helper checks the mapped path and fragment ownership and uses `verifiedRevision` to detect drift. For an existing fragment, pass the exact mapped `webgal` as `before`, including line endings. Keep any unchanged commands in `after`. Omit `left` and `right` to use the recorded anchors, or supply a suffix of `left` and a prefix of `right` to narrow the context. A drifted scene needs at least one matching recorded anchor. A new fragment may insert at an unambiguous boundary with empty `before`. To delete, use `removed: true`, an ID removed from the reviewed story, the exact old text of a fragment mapped to this scene, and empty `after`. The helper rejects control characters the server disallows and accepts tabs and line breaks.
4. Use the returned `operation` as the candidate and compare `afterRevision` to `change_plan` for that target. The helper verifies the original-byte revision (including any BOM), produces UTF-16 half-open offsets from BOM-free text, protects character and line boundaries, and emits no operation on ambiguity, stale data or invalid ranges. Review the diff for story/staging intent and check related references with MCP.

```json
{
  "fragmentId": "F002",
  "before": "小禾:「還沒到嗎？」;",
  "after": "小禾:「再等一會吧。」;",
  "left": "changeBg:station.png -next;\n",
  "right": "\nsay:月色很淡。 -clear;"
}
```

## Batch preflight

Before each `change_plan`, check the proposed operations against the connected MCP version's tool contract. Do this for drafts and formal plans, reusing the preflight where inputs are unchanged.

- Count operations and exact target paths. Check that create-only targets are absent, target parents and kinds are supported, and proposed source files match their reviewed revisions. Measure actual file sizes and projected scene/config bytes in the target encoding, including unchanged text and any BOM. Track buffered and streamed totals separately.
- For webgal-mcp 0.3.0, a normal batch allows 1–32 operations. Buffered outputs allow 1 MiB per file and 4 MiB per batch. Background and BGM imports above 1 MiB stream, with 16 MiB per file and 32 MiB per batch in that separate budget. Other ordinary imports stay within the buffered limit.
- Verify image/audio formats against both import and playback support. Use an authorized compatible derivative or a disclosed, approved fallback where available. Route writes through the MCP coordinator.
- If a batch exceeds a limit, partition it before calling `change_plan`. Keep related items together when they fit. If a scene needs assets from an earlier batch, verify they were applied and read back before planning that dependent scene. Report blocked items and their affected cues before handoff.

## From draft to write

- For creation and staging changes that affect asset requirements, resolve [asset readiness](assets-and-staging.md#asset-readiness-after-script-review) before drafting executable scenes. Preflight and build a non-committable `change_plan({projectId, operations})` for each eligible batch. Check its diagnostics and confirm only authorized targets and operations appear. Resolve truncated diagnostics before the applicable handoff. Keep the normal scope, handoff, separate plan approval, pending record, backup, and readback for every write batch.
- Ask the user to save successfully and close all Terre editing pages for the specific target. Preserve the user's reply and exact `game/...` paths. Start `write_session_begin({projectId,paths,decision:"saved-and-editors-closed",statement})` only after that reply. The MCP session is brief and connection-bound.
- Re-read current target revisions and related staging or cross-scene dependencies after handoff. Recheck the batch preflight against the saved inputs, then use `change_plan({projectId,sessionId,operations})` for the formal plan. Compare paths, operation types, before and after hashes, and source revisions to the draft. On drift, end the old session, update the draft and reviews, and get any required fresh handoff. Obtain explicit application approval for the actual formal plan. Recheck the approved story hash and any relevant unscheduled dependencies just before apply. A dependency read is a snapshot, so it still needs handoff and deliberate scope.
- Atomically persist `pending` before calling `change_apply({sessionId,planId,idempotencyKey})`. Include the `storySha256`, `planId`, a newly generated UUID `idempotencyKey`, and an array of `{path,beforeRevision,afterRevision}` from the formal plan, including assets/config. Also include proposed scene/fragment changes (new baselines, deletions, and which unrelated fragments remain `pending-terre`). Keep the current map baselines until verification. If saving or verifying the pending record fails, stop before apply.
- After apply, read actual target versions before advancing the mapping. End the handoff with `write_session_end({sessionId})` even on cancellation or failure if the connection remains available, and record any end/lock warning. Treat session close and readiness to resume editing as separate checks. For a `partial`, `uncertain`, or otherwise unresolved result, first tell the user to keep the affected Terre editing pages closed. Run `recovery_inspect`, verify the actual on-disk state, and resolve applicable lock or recovery warnings. Prompt reopening only after the session has ended and the checked project state is safe for the user to edit.

## Pending record and recovery

On any restart or loss of the receipt, query `recovery_inspect({projectId,planId})` first. For a discovered batch, get its `batchId` details with `recovery_inspect({projectId,batchId})` if needed. Compare the full set of target paths and current revisions to the pending record, including asset revisions from the recovery report. Independently reread saved scenes with `scene_read` and config via `project_inspect.configRevision`. Validate the intended fragments against saved WebGAL.

Only a complete batch with every target still matching the planned after-revision can advance the map. Fold in only the verified delta, including new verified scene revisions and retained unsynced fragments. Persist the whole new map and `pending: null` in the same atomic replacement. A current `story.md` that changed meanwhile is additional unsynced Markdown; advance only the recorded old approved fragments proven on disk and request review for subsequent changes. Recovery makes no additional game write.

For failed, partial, uncertain, missing or mismatched batches, keep both the pending record and old baselines. Report the original, planned, missing, changed and unreadable targets as actually observed, and pause new writes from this creation directory. Ask the user to keep the affected Terre editing pages closed while the disk state or any lock warning remains unresolved. Resolve with the user before clearing the record or preparing another plan. A verified partial result can be handed back when the recovery decision is settled and the applicable lock warnings are resolved. Retain the previous synchronized baselines when handing back a partial result. Treat `recovery_restore` as a separate user-reviewed write with fresh handoff and exact file choices. Preserve backups and created files.

## Atomic map update on Windows

Run the following PowerShell 7 block as a script in the private staging area or as a script block. Set `Directory` to the verified private, local creation directory outside all game, public and asset directories. Set `Expected` to the SHA-256 of the exact map bytes last read (or `absent` for a first write) and `Json` to the entire next map JSON. The returned revision becomes the expected hash for the next save. The write uses a same-directory temporary file and compares the old revision under a local mutex. Re-read and verify the pending record before sending an apply request. If replacement fails, keep the already published map and re-read it.

```powershell
param(
  [Parameter(Mandatory)][string]$Directory,
  [Parameter(Mandatory)][string]$Expected,
  [Parameter(Mandatory)][string]$Json
)
$ErrorActionPreference = 'Stop'
$directoryItem = Get-Item -LiteralPath $Directory
if (!$directoryItem.PSIsContainer -or ($directoryItem.Attributes -band [IO.FileAttributes]::ReparsePoint)) {
  throw 'Use an existing private, non-link creation directory.'
}
$mapPath = Join-Path $directoryItem.FullName 'script-map.json'
$mutexBytes = [Text.Encoding]::UTF8.GetBytes($mapPath.ToUpperInvariant())
$mutexId = [Convert]::ToHexString([Security.Cryptography.SHA256]::HashData($mutexBytes))
$mutex = [Threading.Mutex]::new($false, "WebGALCreator-$mutexId")
$locked = $false
$temporaryPath = $null
try {
  try { $locked = $mutex.WaitOne([TimeSpan]::FromSeconds(3)) }
  catch [Threading.AbandonedMutexException] { $locked = $true }
  if (!$locked) { throw 'The creation directory is busy.' }

  $mapItem = Get-Item -LiteralPath $mapPath -ErrorAction SilentlyContinue
  $actual = 'absent'
  if ($mapItem) {
    if ($mapItem.PSIsContainer -or ($mapItem.Attributes -band [IO.FileAttributes]::ReparsePoint)) {
      throw 'script-map.json is not a regular file.'
    }
    $actual = (Get-FileHash -LiteralPath $mapPath -Algorithm SHA256).Hash
  }
  if ($actual -ine $Expected) { throw 'script-map.json changed. Read it again before proceeding.' }

  $parsed = ConvertFrom-Json -InputObject $Json -AsHashtable -ErrorAction Stop
  if ($parsed.schemaVersion -ne 1 -or !$parsed.project.id -or !$parsed.project.previewUrl -or
      !$parsed.Contains('scenes') -or !$parsed.Contains('pending')) {
    throw 'Incomplete script-map.json state.'
  }
  $file = Join-Path $directoryItem.FullName ('.script-map.' + [Guid]::NewGuid().ToString('N') + '.tmp')
  $bytes = [Text.UTF8Encoding]::new($false, $true).GetBytes($Json)
  $stream = [IO.File]::Open($file, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
  $temporaryPath = $file
  try {
    $stream.Write($bytes, 0, $bytes.Length)
    $stream.Flush($true)
  } finally {
    $stream.Dispose()
  }
  [IO.File]::Move($temporaryPath, $mapPath, $true)
  $temporaryPath = $null
  (Get-FileHash -LiteralPath $mapPath -Algorithm SHA256).Hash.ToLowerInvariant()
} finally {
  if ($temporaryPath) { Remove-Item -LiteralPath $temporaryPath -ErrorAction SilentlyContinue }
  if ($locked) { $mutex.ReleaseMutex() }
  $mutex.Dispose()
}
```
