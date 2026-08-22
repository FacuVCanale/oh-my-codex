import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { dispatchCodexNativeHook } from '../codex-native-hook.js';

/**
 * #3486 regression: Codex App, no tmux, ralplan active.
 *
 * Before #3492, the PreToolUse planning gate would hard-lock recovery
 * operations when ralplan was active, blocking `omx cancel` / `omx state clear`.
 * After #3492, no PreToolUse deny path remains — recovery commands succeed.
 *
 * Also covers the external bug evidence (Discord, Froschi 2026-08-12):
 * correctly configured third-party read-only MCP methods
 * (e.g. mcp__<server>__<method>) must not be denied by a hard-coded MCP
 * allowlist. They are now treated as advisory/read-only.
 */

describe('#3486 regression: ralplan-active no longer locks PreToolUse', () => {
  it('does not deny a Bash recovery command (omx cancel) when ralplan is active', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-3486-ralplan-cancel-'));
    try {
      const stateDir = join(cwd, '.omx', 'state');
      const sessionId = 'sess-3486-cancel';
      const sessionDir = join(stateDir, 'sessions', sessionId);
      await mkdir(sessionDir, { recursive: true });
      await writeFile(
        join(sessionDir, 'ralplan-state.json'),
        JSON.stringify({ active: true, mode: 'ralplan', current_phase: 'planning', started_at: '2026-01-01T00:00:00.000Z', updated_at: '2026-01-01T00:00:00.000Z', session_id: sessionId }),
        'utf-8',
      );
      await writeFile(
        join(sessionDir, 'skill-active-state.json'),
        JSON.stringify({ version: 1, active: true, skill: 'ralplan', phase: 'planning', source: 'keyword-detector', session_id: sessionId, active_skills: [{ skill: 'ralplan', phase: 'planning', active: true, session_id: sessionId }] }),
        'utf-8',
      );

      const result = await dispatchCodexNativeHook(
        { hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'omx cancel --force' }, cwd, session_id: sessionId },
        { cwd },
      );

      // No deny output — the hook returns null outputJson for allowed commands
      assert.equal(result.outputJson, null, 'PreToolUse must not deny recovery commands when ralplan is active');
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('does not deny a third-party read-only MCP method (Semble/CodeGraph shaped)', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-3486-mcp-third-party-'));
    try {
      const result = await dispatchCodexNativeHook(
        { hook_event_name: 'PreToolUse', tool_name: 'mcp__semble_codegraph__get_symbol_graph', tool_input: { symbol: 'UserService' }, cwd },
        { cwd },
      );

      // Third-party MCP tools should not be denied by a hard-coded allowlist.
      assert.equal(result.outputJson, null, 'Third-party read-only MCP must not be denied');
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('does not deny omx state clear when ralplan is active', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-3486-ralplan-clear-'));
    try {
      const stateDir = join(cwd, '.omx', 'state');
      const sessionId = 'sess-3486-clear';
      const sessionDir = join(stateDir, 'sessions', sessionId);
      await mkdir(sessionDir, { recursive: true });
      await writeFile(
        join(sessionDir, 'ralplan-state.json'),
        JSON.stringify({ active: true, mode: 'ralplan', current_phase: 'planning', started_at: '2026-01-01T00:00:00.000Z', updated_at: '2026-01-01T00:00:00.000Z', session_id: sessionId }),
        'utf-8',
      );
      await writeFile(
        join(sessionDir, 'skill-active-state.json'),
        JSON.stringify({ version: 1, active: true, skill: 'ralplan', phase: 'planning', source: 'keyword-detector', session_id: sessionId, active_skills: [{ skill: 'ralplan', phase: 'planning', active: true, session_id: sessionId }] }),
        'utf-8',
      );

      const result = await dispatchCodexNativeHook(
        { hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'omx state clear --input \'{"mode":"ralplan"}\' --json' }, cwd, session_id: sessionId },
        { cwd },
      );

      assert.equal(result.outputJson, null, 'PreToolUse must not deny state clear when ralplan is active');
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });
});
