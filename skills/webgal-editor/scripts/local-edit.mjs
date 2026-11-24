import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';

function check(condition, message) {
  if (!condition) throw new Error(message);
}

function bytes(text, encoding) {
  return Buffer.from((encoding === 'utf-8-bom' ? '\uFEFF' : '') + text);
}

const hash = data => createHash('sha256').update(data).digest('hex');
const validText = text => typeof text === 'string' && text.isWellFormed()
  && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(text);

function linesOf(text) {
  const lines = [];
  let start = 0;
  for (const end of text.matchAll(/\r\n|\n|\r/g)) {
    lines.push({ start, text: text.slice(start, end.index), eol: end[0] });
    start = end.index + end[0].length;
  }
  lines.push({ start, text: text.slice(start), eol: '' });
  return lines;
}

// Match complete physical lines, including the internal line endings.
function occurrences(text, lines, block) {
  const positions = new Map(lines.map((line, i) => [line.start, i]));
  const matches = [];
  for (let pos = text.indexOf(block); pos !== -1; pos = text.indexOf(block, pos + 1)) {
    const end = pos + block.length;
    if (positions.has(pos) && (end === text.length || /^[\r\n]$/.test(text[end]))
      && !(text[end - 1] === '\r' && text[end] === '\n')) matches.push(positions.get(pos));
  }
  return matches;
}

function context(lines, index, count) {
  return { left: lines[index - 1]?.text ?? null, right: lines[index + count]?.text ?? null };
}

function makeEdit(scene, start, before, after) {
  check(validText(after) && before !== after && after.length > 0, 'Supply a changed, nonempty local block.');
  const candidate = scene.text.slice(0, start) + after + scene.text.slice(start + before.length);
  const result = bytes(candidate, scene.encoding);
  check(result.length <= 1024 * 1024, 'Edited scene exceeds the MCP text limit.');
  return {
    operation: { type: 'edit_scene', path: scene.path, expectedRevision: scene.revision,
      edits: [{ start, end: start + before.length, text: after }] },
    afterRevision: hash(result),
  };
}

function run({ mode, scene, projectId, needle, firstLine, lastLine = firstLine, before, after, receipt,
  target, x, duration, cues }, cueBeforeLine) {
  check(projectId && scene?.source === 'disk' && typeof scene.path === 'string'
    && validText(scene.text) && ['utf-8', 'utf-8-bom'].includes(scene.encoding), 'Use an original scene_read snapshot.');
  const raw = bytes(scene.text, scene.encoding);
  check(raw.length === scene.bytes && hash(raw) === scene.revision, 'Saved bytes disagree with scene_read.');
  const lines = linesOf(scene.text);
  if (cueBeforeLine !== undefined) {
    const anchor = lines[firstLine - 1];
    check(Number.isInteger(firstLine) && anchor?.text && anchor.text === before,
      'Select the exact saved dialogue line before which the model changes.');
    const eol = lines[firstLine - 2]?.eol || anchor.eol || '\n';
    const insertion = cueBeforeLine + eol;
    const draft = run({ mode: 'draft', projectId, scene, firstLine, before, after: insertion + before });
    return { ...draft, candidateText: scene.text.slice(0, anchor.start) + insertion + scene.text.slice(anchor.start) };
  }
  if (mode === 'bgm') {
    check(Array.isArray(cues) && cues.length > 0, 'Supply music cues in saved line order.');
    const edits = cues.map(({ line, before: anchorText, track }, index) => {
      const anchor = lines[line - 1];
      check(Number.isInteger(line) && anchor?.text && anchor.text === anchorText
        && (index === 0 || line > cues[index - 1].line), 'Select distinct, ordered, exact anchor lines.');
      check(typeof track === 'string' && track.trim() === track && track.length > 0
        && validText(track) && !/[;\r\n]/u.test(track) && !/\s-/u.test(track),
      'Use the verified music filename or none.');
      const eol = lines[line - 2]?.eol || anchor.eol || '\n';
      return { start: anchor.start, end: anchor.start, text: `bgm:${track} -next;${eol}` };
    });
    const first = cues[0].line;
    const last = cues.at(-1).line;
    const start = lines[first - 1].start;
    const end = lines[last - 1].start + lines[last - 1].text.length;
    const block = scene.text.slice(start, end);
    const insertions = new Map(edits.map(edit => [edit.start, edit.text]));
    const expanded = lines.slice(first - 1, last).map((line, i) =>
      (insertions.get(line.start) ?? '') + line.text + (first + i < last ? line.eol : '')).join('');
    const draft = run({ mode: 'draft', projectId, scene, firstLine: first, lastLine: last, before: block, after: expanded });
    return { ...draft, operation: { ...draft.operation, edits },
      candidateText: scene.text.slice(0, start) + expanded + scene.text.slice(end) };
  }
  if (mode === 'move') {
    const anchor = lines[firstLine - 1];
    check(Number.isInteger(firstLine) && anchor?.text && anchor.text === before,
      'Select the exact saved line before which the figure moves.');
    check(typeof target === 'string' && /^[\p{L}\p{N}_.-]+$/u.test(target),
      'Supply the active figure ID or figure slot.');
    check(Number.isFinite(x) && Number.isSafeInteger(duration) && duration > 0,
      'Supply a finite destination x and a positive duration in milliseconds.');
    const command = `setTransform:{"position":{"x":${x}}} -target=${target} -duration=${duration} -ease=easeOut -keep -next;`;
    const eol = lines[firstLine - 2]?.eol || anchor.eol || '\n';
    return run({ mode: 'draft', projectId, scene, firstLine, before, after: command + eol + anchor.text });
  }
  if (mode === 'find') {
    check(typeof needle === 'string' && needle.length > 0, 'Supply a nonempty literal.');
    return lines.flatMap((line, i) => line.text.includes(needle)
      ? [{ line: i + 1, text: line.text, ...context(lines, i, 1) }] : []);
  }
  if (mode === 'draft') {
    check(Number.isInteger(firstLine) && Number.isInteger(lastLine)
      && firstLine >= 1 && lastLine >= firstLine && lastLine <= lines.length, 'Invalid saved line range.');
    const start = lines[firstLine - 1].start;
    const last = lines[lastLine - 1];
    check(before && before === scene.text.slice(start, last.start + last.text.length),
      'The selected lines differ from the reviewed text.');
    const plan = makeEdit(scene, start, before, after);
    const postText = scene.text.slice(0, start) + after + scene.text.slice(start + before.length);
    const postLines = linesOf(postText);
    const count = linesOf(after).length;
    const anchors = context(postLines, firstLine - 1, count);
    const hits = occurrences(postText, postLines, after).map(i => context(postLines, i, count));
    return { ...plan, receipt: { projectId, path: scene.path, beforeRevision: scene.revision,
      afterRevision: plan.afterRevision, start, before, after, ...anchors,
      uniqueLeft: postLines.filter(line => line.text === anchors.left).length === 1,
      uniqueRight: postLines.filter(line => line.text === anchors.right).length === 1,
      uniquePair: hits.filter(hit => hit.left === anchors.left && hit.right === anchors.right).length === 1 } };
  }
  check(mode === 'undo' && receipt?.projectId === projectId && receipt.path === scene.path,
    'Select the receipt belonging to this project and scene.');
  check(validText(receipt.after) && receipt.after.length && validText(receipt.before) && receipt.before.length,
    'The receipt lacks an exact before/after block.');
  let start = receipt.start;
  if (scene.revision !== receipt.afterRevision) {
    const count = linesOf(receipt.after).length;
    const hits = occurrences(scene.text, lines, receipt.after);
    const leftCount = lines.filter(line => line.text === receipt.left).length;
    const rightCount = lines.filter(line => line.text === receipt.right).length;
    const anchored = hits.filter(index => {
      const { left, right } = context(lines, index, count);
      const leftMatches = left === receipt.left;
      const rightMatches = right === receipt.right;
      return (receipt.uniquePair && leftMatches && rightMatches)
        || (receipt.uniqueLeft && left && leftMatches && leftCount === 1 && !rightCount && receipt.right !== null)
        || (receipt.uniqueRight && right && rightMatches && rightCount === 1 && !leftCount && receipt.left !== null);
    });
    check(anchored.length === 1, 'Conflict: applied text or its identifying context changed or is ambiguous.');
    start = lines[anchored[0]].start;
  }
  check(Number.isSafeInteger(start) && start >= 0
    && scene.text.slice(start, start + receipt.after.length) === receipt.after, 'Conflict: applied text changed.');
  // A reverse edit gets its own receipt and follows the same plan/approval protocol.
  const index = lines.findIndex(line => line.start === start);
  return run({ mode: 'draft', scene, projectId, firstLine: index + 1,
    lastLine: index + linesOf(receipt.after).length, before: receipt.after, after: receipt.before });
}

try {
  const request = JSON.parse(readFileSync(0, 'utf8'));
  let cueBeforeLine;
  if (request.mode === 'live2d') {
    const moduleUrl = new URL('../../webgal-live2d/scripts/figure-cue.mjs', import.meta.url);
    if (!existsSync(moduleUrl)) throw new Error('Install webgal-live2d alongside webgal-editor for Live2D staging.');
    const { buildFigureCue } = await import(moduleUrl);
    cueBeforeLine = buildFigureCue(request);
  }
  process.stdout.write(JSON.stringify(run(request, cueBeforeLine)) + '\n');
} catch (error) {
  process.stderr.write(error.message + '\n');
  process.exitCode = 1;
}
