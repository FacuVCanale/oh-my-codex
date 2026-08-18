import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

import { STATE_NAMESPACE_OWNERS, WORKFLOW_STATE_WRITER, declaredStateWriters, namespacesOwnedBy } from '../namespace-owners.js';

// When compiled, __dirname is dist/state/__tests__/ — go up 4 to repo root, then into src.
const repoRoot = join(fileURLToPath(import.meta.url), '..', '..', '..', '..');
const srcDir = join(repoRoot, 'src');

/**
 * #3498 follow-up — the state-writer audit.
 *
 * The previous version of this file scanned text for one pattern: a module that mentioned
 * `getStateFilename` and `writeFile` without `writeStateFile`. That missed every other way to
 * persist a projection — hard-coded `'<mode>-state.json'` literals, template paths, generic
 * directory scans, `rename`, `appendFile`, and file-handle `open`/`write`/`truncate` — which is why
 * roughly a dozen direct writers went undetected while the docs claimed a single writer.
 *
 * This audit scans each source file and reports any mutation call
 * whose path argument references a mode-state projection, then requires the containing module to be
 * a declared owner in `src/state/namespace-owners.ts`. Declaring reality is the point: the workflow
 * namespace has one sanctioned writer, and every other writer is named with a reason. A NEW
 * undeclared writer fails this test.
 *
 * KNOWN RESIDUAL GAP, stated because an audit that overstates its reach is worse than one that does
 * not: detection is lexical, not semantic. It sees a projection path written directly, through the
 * suffix constant, through `getStateFilename`/`resolveSeedStateFilePath`, or through a file handle
 * opened directly on such a path. It does NOT follow a path bound to an intermediate variable first.
 * A real TypeScript AST pass is the correct fix, but this repo's TypeScript 7 exports no classic
 * compiler API at its main entry (only `typescript/unstable/*`), and pinning a load-bearing invariant
 * test to an explicitly unstable API surface trades one weakness for a worse one. A lexical taint pass
 * was implemented and measured instead: it false-positives on identifiers as common as `path`, and the
 * only way to quiet those would be declaring innocent modules as owners, which would void the very map
 * this audit consumes. The gap is asserted as a test case so it cannot be mistaken for coverage.
 */

const MUTATING_CALLS = new Set([
  'writeFile',
  'writeFileSync',
  'appendFile',
  'appendFileSync',
  'rename',
  'renameSync',
  'truncate',
  'truncateSync',
  'copyFile',
  'copyFileSync',
  'write',
  'writev',
  // `open` matters because the write happens later through the returned handle; without it a
  // projection opened for writing and written via `handle.write(payload)` was invisible.
  'open',
  'openSync',
  'createWriteStream',
]);

// `handle.write(...)` is a property call, so the audit also allows a bare `.write(` form for the
// file-handle shape the previous lexical scan could not see at all.
const HANDLE_WRITE_PATTERN = /\.\s*(write|writev|truncate)\s*\(/g;

const STATE_FILE_HINTS = [
  'getStateFilename',
  'resolveSeedStateFilePath',
  'stateFilePath',
  'getStatePath',
  '-state.json',
  'STATE_FILE_SUFFIX',
];

async function collectTsFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === '__tests__' || entry.name === 'node_modules') continue;
      files.push(...await collectTsFiles(fullPath));
    } else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.d.ts')) {
      files.push(fullPath);
    }
  }
  return files;
}

/**
 * Blank out comments and string/template literals, preserving byte offsets and newlines so reported
 * line numbers stay correct.
 *
 * Raw scanning is unsound without this: `writeFile(/* ) *\/ join(dir, 'ralph-state.json'), body)`
 * closes the argument list inside a comment, and a projection name mentioned in a doc comment or an
 * unrelated string would be reported as a write. Masking first keeps the scan honest without pulling
 * in a parser.
 */
/**
 * File-handle identifiers obtained by opening a projection path.
 *
 * `const h = await open(join(dir, 'ralph-state.json'), 'w'); await h.write(payload);` writes through a
 * handle whose own call site mentions no path, so the handle is tracked from its `open`.
 *
 * KNOWN LIMIT, stated rather than papered over: this only follows a handle whose `open` call names the
 * projection DIRECTLY. A path bound to an intermediate variable first is not followed, because doing
 * that soundly needs real dataflow - a lexical taint pass over identifiers like `path` produces false
 * positives on unrelated writers, and silencing those by declaring innocent modules as owners would
 * destroy the meaning of the owner map. See the audit's docstring for the residual gap.
 */
function taintedHandleIdentifiers(rawContent: string): Set<string> {
  const handles = new Set<string>();
  const opened = /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:await\s+)?(?:fs\.)?openS?y?n?c?\s*\(([^)]*)\)/g;
  for (const match of rawContent.matchAll(opened)) {
    if (STATE_FILE_HINTS.some((hint) => (match[2] ?? '').includes(hint))) handles.add(match[1]);
  }
  return handles;
}

function maskCommentsAndLiterals(content: string): string {
  const out = content.split('');
  let index = 0;
  const blank = (start: number, end: number): void => {
    for (let i = start; i < end && i < out.length; i += 1) {
      if (out[i] !== '\n') out[i] = ' ';
    }
  };
  while (index < content.length) {
    const char = content[index];
    const next = content[index + 1];
    if (char === '/' && next === '/') {
      const end = content.indexOf('\n', index);
      blank(index, end === -1 ? content.length : end);
      index = end === -1 ? content.length : end;
      continue;
    }
    if (char === '/' && next === '*') {
      const end = content.indexOf('*/', index + 2);
      const stop = end === -1 ? content.length : end + 2;
      blank(index, stop);
      index = stop;
      continue;
    }
    if (char === '`') {
      // Template literals are masked EXCEPT their ${...} expressions, which are executable code. The
      // earlier revision blanked the whole literal, which newly hid a real writer placed inside an
      // interpolation - a regression this case exists to prevent.
      let i = index + 1;
      let segmentStart = index;
      while (i < content.length) {
        if (content[i] === '\\') { i += 2; continue; }
        if (content[i] === '$' && content[i + 1] === '{') {
          blank(segmentStart, i);
          let depth = 1;
          let j = i + 2;
          while (j < content.length && depth > 0) {
            if (content[j] === '{') depth += 1;
            else if (content[j] === '}') depth -= 1;
            j += 1;
          }
          i = j;
          segmentStart = i;
          continue;
        }
        if (content[i] === '`') break;
        i += 1;
      }
      blank(segmentStart, Math.min(i + 1, content.length));
      index = i + 1;
      continue;
    }
    if (char === '"' || char === "'") {
      let i = index + 1;
      while (i < content.length) {
        if (content[i] === '\\') { i += 2; continue; }
        if (content[i] === char) break;
        i += 1;
      }
      blank(index, Math.min(i + 1, content.length));
      index = i + 1;
      continue;
    }
    index += 1;
  }
  return out.join('');
}

/**
 * Extract the balanced argument text of a call that starts at `openParen`, so a multi-line call is
 * inspected in full rather than one line at a time.
 */
function balancedArguments(content: string, openParen: number): string | null {
  let depth = 0;
  for (let index = openParen; index < content.length; index += 1) {
    const char = content[index];
    if (char === '(') depth += 1;
    else if (char === ')') {
      depth -= 1;
      if (depth === 0) return content.slice(openParen + 1, index);
    }
  }
  return null;
}

interface Violation {
  module: string;
  line: number;
  call: string;
  snippet: string;
}

function auditSource(relPath: string, rawContent: string): Violation[] {
  const violations: Violation[] = [];
  // Detect against masked source so comments and literals cannot fake or hide a call; the mask
  // preserves offsets, so hint matching and line numbers still line up with the real file.
  const content = maskCommentsAndLiterals(rawContent);
  const handles = taintedHandleIdentifiers(rawContent);
  const mentionsProjection = (args: string): boolean => STATE_FILE_HINTS.some((hint) => args.includes(hint));

  // Writes through a handle opened on a projection path: the call site names no path at all.
  for (const handle of handles) {
    const handleWrite = new RegExp(`(?<![\\w$])${handle}\\s*\\.\\s*(write|writev|truncate|writeFile)\\s*\\(`, 'g');
    for (const match of content.matchAll(handleWrite)) {
      violations.push({
        module: relPath,
        line: content.slice(0, match.index).split('\n').length,
        call: `${handle}.${match[1]}`,
        snippet: `${handle}.${match[1]}(...) on a handle opened for a mode-state projection`,
      });
    }
  }
  for (const handleMatch of content.matchAll(HANDLE_WRITE_PATTERN)) {
    const openParen = handleMatch.index + handleMatch[0].length - 1;
    const args = balancedArguments(content, openParen);
    if (args === null) continue;
    const rawArgs = rawContent.slice(openParen + 1, openParen + 1 + args.length);
    if (!mentionsProjection(rawArgs)) continue;
    violations.push({
      module: relPath,
      line: content.slice(0, handleMatch.index).split('\n').length,
      call: `handle.${handleMatch[1]}`,
      snippet: `${handleMatch[0]}${rawArgs})`.replace(/\s+/g, ' ').slice(0, 120),
    });
  }
  for (const call of MUTATING_CALLS) {
    const pattern = new RegExp(`(?<![\\w.$])${call}\\s*\\(`, 'g');
    for (const match of content.matchAll(pattern)) {
      const openParen = match.index + match[0].length - 1;
      const args = balancedArguments(content, openParen);
      if (args === null) continue;
      // Hints are matched on the RAW argument text: a hard-coded '<mode>-state.json' lives inside a
      // string literal, which the mask blanks out. The mask is only used to find real call sites and
      // real parentheses.
      const rawArgs = rawContent.slice(openParen + 1, openParen + 1 + args.length);
      if (!mentionsProjection(rawArgs)) continue;
      violations.push({
        module: relPath,
        line: content.slice(0, match.index).split('\n').length,
        call,
        snippet: `${call}(${rawArgs})`.replace(/\s+/g, ' ').slice(0, 120),
      });
    }
  }
  return violations.sort((left, right) => left.line - right.line);
}

describe('State writer audit (#3498)', () => {
  it('reports no undeclared module persisting a mode-state projection', async () => {
    const declared = declaredStateWriters();
    const files = await collectTsFiles(srcDir);
    const undeclared: Violation[] = [];

    for (const filePath of files) {
      const relPath = relative(srcDir, filePath).replaceAll('\\', '/');
      if (declared.has(relPath)) continue;
      const content = await readFile(filePath, 'utf-8');
      undeclared.push(...auditSource(relPath, content));
    }

    assert.deepEqual(
      undeclared,
      [],
      'These modules persist a mode-state projection but are not declared in '
      + `src/state/namespace-owners.ts: ${undeclared.map((v) => `${v.module}:${v.line} (${v.call}) ${v.snippet}`).join(' | ')}`,
    );
  });

  it('detects mutation shapes the previous lexical scan missed', () => {
    // A hard-coded literal path with no getStateFilename call.
    assert.equal(
      auditSource('fake/hardcoded.ts', "await writeFile(join(dir, 'ralph-state.json'), body);").length,
      1,
      'a hard-coded {mode}-state.json literal must be detected',
    );
    // rename, not writeFile.
    assert.equal(
      auditSource('fake/renamer.ts', "await rename(tmp, join(dir, 'autopilot-state.json'));").length,
      1,
      'rename onto a projection path must be detected',
    );
    // A file handle write through the suffix constant.
    assert.equal(
      auditSource('fake/handle.ts', 'await handle.write(payload, 0, STATE_FILE_SUFFIX);').length,
      1,
      'handle writes referencing the state suffix must be detected',
    );
    // Unrelated writes must not be flagged.
    assert.deepEqual(
      auditSource('fake/unrelated.ts', "await writeFile(join(dir, 'notes.md'), body);"),
      [],
      'writes unrelated to mode state must not be flagged',
    );
    // A comment containing a close paren must not truncate the argument scan.
    assert.equal(
      auditSource('fake/comment.ts', "await writeFile(/* ) */ join(dir, 'ralph-state.json'), body);").length,
      1,
      'a close paren inside a comment must not hide the call',
    );
    // A projection name mentioned only in a comment is not a write.
    assert.deepEqual(
      auditSource('fake/mention.ts', "// writeFile(join(dir, 'ralph-state.json'), body)\nconst x = 1;"),
      [],
      'a commented-out call must not be reported',
    );
    // A call name inside a string literal is not a call.
    assert.deepEqual(
      auditSource('fake/string.ts', "const doc = \"writeFile(join(dir, 'ralph-state.json'))\";"),
      [],
      'a call name inside a string literal must not be reported',
    );
    // The terminal critic's evasion, in the form this audit DOES close: a handle opened directly on a
    // projection path, then written through the handle.
    assert.ok(
      auditSource(
        'fake/handle-flow.ts',
        "const h = await open(join(dir, 'ralph-state.json'), 'w');\nawait h.write(payload);",
      ).length >= 1,
      'a handle opened on a projection path must be detected',
    );
    // Residual gap, asserted so it is a KNOWN limit rather than an assumed capability: a path bound to
    // an intermediate variable first is not followed. Closing it needs real dataflow; a lexical taint
    // pass was implemented, measured, and reverted because it false-positives on identifiers as common
    // as `path`, and silencing that by declaring innocent modules as owners would void the owner map.
    assert.deepEqual(
      auditSource('fake/var-path.ts', "const p = join(dir, 'ralph-state.json');\nawait writeFile(p, body);"),
      [],
      'documents the known dataflow gap; if this ever starts failing, the audit got stronger and this case should assert detection',
    );
    // A real writer inside a template interpolation is executable code and MUST still be detected.
    assert.equal(
      auditSource('fake/interp.ts', 'const x = `prefix ${await writeFile(join(dir, "ralph-state.json"), body)} suffix`;').length,
      1,
      'a writer inside a ${...} interpolation must not be masked away',
    );
    // Template text that merely mentions a projection is not a write.
    assert.deepEqual(
      auditSource('fake/tmpl.ts', 'const doc = `writeFile(join(dir, "ralph-state.json"))`;'),
      [],
      'template text mentioning a projection must not be reported',
    );
  });

  it('names one sanctioned writer for the workflow namespace', () => {
    const workflow = STATE_NAMESPACE_OWNERS.find((entry) => entry.namespace === 'workflow');
    assert.ok(workflow, 'a workflow namespace owner entry must exist');
    assert.equal(workflow.owners[0], WORKFLOW_STATE_WRITER);
    assert.ok(
      namespacesOwnedBy(WORKFLOW_STATE_WRITER).includes('workflow'),
      'operations.ts must own the workflow namespace',
    );
    for (const entry of STATE_NAMESPACE_OWNERS) {
      assert.ok(entry.owners.length > 0, `${entry.namespace} must declare at least one owner`);
      assert.ok(entry.reason.trim().length > 0, `${entry.namespace} must state why it owns the namespace`);
    }
  });

  it('keeps the MCP state projection read-only', async () => {
    const content = await readFile(join(srcDir, 'mcp', 'state-server.ts'), 'utf-8');
    // Scope to the advertised buildStateServerTools body only: state_write/state_clear still exist
    // behind buildStateServerWriterTools for explicit programmatic callers, and conflating the two
    // would make this assertion meaningless.
    const match = content.match(/export\s+function\s+buildStateServerTools\s*\(\)\s*\{([\s\S]*?)\n\}/);
    assert.ok(match, 'expected buildStateServerTools function in state-server.ts');
    const toolsBody = match[1]!;
    const toolNames = toolsBody.match(/name:\s*"state_\w+"/g);
    assert.ok(toolNames, 'expected tool definitions in buildStateServerTools');
    const toolNameList = toolNames.map((entry) => entry.match(/"state_\w+"/)![0]);
    assert.ok(!toolNameList.includes('"state_write"'), 'buildStateServerTools must not advertise state_write');
    assert.ok(!toolNameList.includes('"state_clear"'), 'buildStateServerTools must not advertise state_clear');
    assert.ok(toolNameList.includes('"state_read"'), 'buildStateServerTools must still advertise state_read');
    assert.ok(toolNameList.includes('"state_list_active"'), 'buildStateServerTools must still advertise state_list_active');
    assert.ok(toolNameList.includes('"state_get_status"'), 'buildStateServerTools must still advertise state_get_status');
  });

  it('does not reintroduce automatic launch-time state neutralization', async () => {
    const content = await readFile(join(srcDir, 'cli', 'index.ts'), 'utf-8');
    assert.doesNotMatch(
      content,
      /neutralizeStaleWorkflowStateProjections/,
      'the launch path must not neutralize projections automatically; use omx doctor --repair-state',
    );
    const operations = await readFile(join(srcDir, 'state', 'operations.ts'), 'utf-8');
    assert.doesNotMatch(
      operations,
      /export\s+async\s+function\s+neutralizeStaleWorkflowStateProjections/,
      'the in-place neutralizer was removed in favour of the archive-based doctor repair path',
    );
  });
});
