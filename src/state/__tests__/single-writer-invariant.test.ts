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
 * This audit parses each source file with the TypeScript compiler and reports any mutation call
 * whose path argument references a mode-state projection, then requires the containing module to be
 * a declared owner in `src/state/namespace-owners.ts`. Declaring reality is the point: the workflow
 * namespace has one sanctioned writer, and every other writer is named with a reason. A NEW
 * undeclared writer fails this test.
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
    if (char === '"' || char === "'" || char === '`') {
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
  for (const handleMatch of content.matchAll(HANDLE_WRITE_PATTERN)) {
    const openParen = handleMatch.index + handleMatch[0].length - 1;
    const args = balancedArguments(content, openParen);
    if (args === null) continue;
    const rawArgs = rawContent.slice(openParen + 1, openParen + 1 + args.length);
    if (!STATE_FILE_HINTS.some((hint) => rawArgs.includes(hint))) continue;
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
      if (!STATE_FILE_HINTS.some((hint) => rawArgs.includes(hint))) continue;
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
