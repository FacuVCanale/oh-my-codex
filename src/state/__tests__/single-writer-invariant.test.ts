import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

// When compiled, __dirname is dist/state/__tests__/ — go up 4 to repo root, then into src.
import { existsSync as pathExistsSync } from 'node:fs';
const repoRoot = join(fileURLToPath(import.meta.url), '..', '..', '..', '..');
const srcDir = join(repoRoot, 'src');

/**
 * #3498 — State SSOT unification invariant.
 *
 * The sole writer of `.omx/state/` session-scoped `{mode}-state.json` files
 * is `src/state/operations.ts` (via `writeStateFile`). No other module under
 * `src/` may call `writeFile` directly to persist a file matching
 * `{mode}-state.json`.
 *
 * This test statically scans source files to prove the invariant. It identifies
 * which modules call the canonical `writeStateFile` export and asserts that no
 * module outside the allowlist writes `{mode}-state.json` via raw `writeFile`.
 */

// Modules that are part of the declared single-writer surface and may
// legitimately contain `writeFile` calls (for run-state.json, skill-active
// copies, ralph artifacts, or other non-mode-state files).
const ALLOWED_WRITER_SURFACE = new Set([
  'state/operations.ts',
  'state/skill-active.ts',
  'runtime/run-state.ts',
  'ralph/persistence.ts',
  'modes/base.ts',          // routes through writeStateFile now
  'state/workflow-transition-reconcile.ts', // routes through writeStateFile now
  'mcp/state-paths.ts',     // state path resolution / revalidation (no writes)
  'hooks/session.ts',       // session pointer lifecycle (not mode state)
  'hud/authority.ts',
  'hud/reconcile.ts',
]);

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

describe('State SSOT single-writer invariant (#3498)', () => {

  it('modes/base.ts writes mode state through writeStateFile, not raw writeFile', async () => {
    const content = await readFile(join(srcDir, 'modes', 'base.ts'), 'utf-8');
    // The import must exist
    assert.match(content, /writeStateFile/, 'modes/base.ts must import writeStateFile from operations.ts');
    // No raw writeFile calls on {mode}-state.json paths
    const stateFileWrites = content.match(/await\s+writeFile\s*\(\s*(?:path|candidatePath)\s*,/g);
    assert.equal(
      stateFileWrites,
      null,
      'modes/base.ts must not use raw writeFile() for mode-state writes; route through writeStateFile()',
    );
  });

  it('workflow-transition-reconcile.ts writes through writeStateFile, not raw writeFile', async () => {
    const content = await readFile(join(srcDir, 'state', 'workflow-transition-reconcile.ts'), 'utf-8');
    assert.match(content, /writeStateFile/, 'workflow-transition-reconcile.ts must import writeStateFile');
    const rawWrites = content.match(/await\s+writeFile\s*\(\s*candidatePath\s*,/g);
    assert.equal(
      rawWrites,
      null,
      'workflow-transition-reconcile.ts must not use raw writeFile() for mode-state writes',
    );
  });

  it('operations.ts exports writeStateFile as the canonical writer primitive', async () => {
    const content = await readFile(join(srcDir, 'state', 'operations.ts'), 'utf-8');
    assert.match(content, /export\s+async\s+function\s+writeStateFile/, 'operations.ts must export writeStateFile');
  });

  it('MCP state-server is read-only: no state_write or state_clear tools in buildStateServerTools', async () => {
    const content = await readFile(join(srcDir, 'mcp', 'state-server.ts'), 'utf-8');
    // Extract only the buildStateServerTools function body, not buildStateServerWriterTools.
    const match = content.match(/export\s+function\s+buildStateServerTools\s*\(\)\s*\{([\s\S]*?)\n\}/);
    assert.ok(match, 'expected buildStateServerTools function in state-server.ts');
    const toolsBody = match[1]!;
    const toolNames = toolsBody.match(/name:\s*"state_\w+"/g);
    assert.ok(toolNames, 'expected tool definitions in buildStateServerTools');
    const toolNameList = toolNames.map((m) => m.match(/"state_\w+"/)![0]);
    assert.ok(
      !toolNameList.includes('"state_write"'),
      'buildStateServerTools must not expose state_write (read-only MCP projection)',
    );
    assert.ok(
      !toolNameList.includes('"state_clear"'),
      'buildStateServerTools must not expose state_clear (read-only MCP projection)',
    );
    assert.ok(
      toolNameList.includes('"state_read"'),
      'buildStateServerTools must still expose state_read',
    );
    assert.ok(
      toolNameList.includes('"state_list_active"'),
      'buildStateServerTools must still expose state_list_active',
    );
    assert.ok(
      toolNameList.includes('"state_get_status"'),
      'buildStateServerTools must still expose state_get_status',
    );
  });

  it('operations.ts exports neutralizeStaleWorkflowStateProjections', async () => {
    const content = await readFile(join(srcDir, 'state', 'operations.ts'), 'utf-8');
    assert.match(
      content,
      /export\s+async\s+function\s+neutralizeStaleWorkflowStateProjections/,
      'operations.ts must export neutralizeStaleWorkflowStateProjections for upgrade-time neutralization',
    );
  });

  it('no module outside the declared writer surface calls writeFile on getStateFilename() paths', async () => {
    const allFiles = await collectTsFiles(srcDir);
    const violations: string[] = [];

    for (const filePath of allFiles) {
      const relPath = relative(srcDir, filePath).replaceAll('\\', '/');
      if (ALLOWED_WRITER_SURFACE.has(relPath)) continue;

      const content = await readFile(filePath, 'utf-8');
      // The invariant: if a module calls both getStateFilename(mode) and writeFile,
      // and does NOT import writeStateFile, it is bypassing the single writer.
      // getStateFilename is the canonical mode-state path constructor; using it
      // with writeFile means writing a {mode}-state.json directly.
      const usesGetStateFilename = content.includes('getStateFilename');
      const hasWriteFile = /\bwriteFile\s*\(/.test(content);
      const usesWriteStateFile = content.includes('writeStateFile');

      if (usesGetStateFilename && hasWriteFile && !usesWriteStateFile) {
        violations.push(relPath);
      }
    }

    assert.deepEqual(
      violations,
      [],
      `These modules use getStateFilename() with writeFile but do not route through writeStateFile: ${violations.join(', ')}`,
    );
  });

  it('src/state/ modules route writes through writeStateFile (no raw writeFile on mode-state paths)', async () => {
    // Within src/state/, only operations.ts, skill-active.ts (canonical copies),
    // and workflow-transition-reconcile.ts should write state files, and all
    // mode-state writes go through writeStateFile.
    const stateModules = ['operations.ts', 'skill-active.ts', 'workflow-transition-reconcile.ts', 'workflow-transition.ts'];
    for (const mod of stateModules) {
      const content = await readFile(join(srcDir, 'state', mod), 'utf-8');
      // workflow-transition.ts should be bookkeeping only (no direct file writes)
      if (mod === 'workflow-transition.ts') {
        const hasWriteFile = /\bwriteFile\s*\(/.test(content);
        assert.equal(
          hasWriteFile,
          false,
          `state/${mod} should be bookkeeping-only (no file writes) per #3498 acceptance`,
        );
      }
    }
  });
});
