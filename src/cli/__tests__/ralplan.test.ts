import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { RALPLAN_HELP, ralplanCommand, type RalplanCommandDependencies } from '../ralplan.js';

async function invoke(args: string[], deps: RalplanCommandDependencies = {}) {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const previous = process.exitCode;
  try {
    process.exitCode = undefined;
    await ralplanCommand(args, { ...deps, stdout: (line) => stdout.push(line), stderr: (line) => stderr.push(line) });
    return { stdout, stderr, exitCode: process.exitCode };
  } finally {
    process.exitCode = previous;
  }
}

describe('#3194 ralplan CLI unsupported-only surface', () => {
  it('documents only fail-closed adapted-authority diagnostics', () => {
    assert.match(RALPLAN_HELP, /fail-closed adapted-authority diagnostics/);
    assert.match(RALPLAN_HELP, /Required only when native role routing is unavailable and adapted Ralplan authority is requested/);
    assert.match(RALPLAN_HELP, /State-preserving diagnostic only/);
    assert.match(RALPLAN_HELP, /Ordinary work remains under its own workflow gates/);
    assert.match(RALPLAN_HELP, /Compatibility diagnostic only: installed roles are denied with unsupported_documented_leader_proof/);
    assert.doesNotMatch(RALPLAN_HELP, /validated role intents/i);
  });
  it('fails the explicit adapted-surface preflight with bounded diagnostics and no state mutation', async () => {
    let resolved = false;
    let probeCalls = 0;
    const result = await invoke(['preflight', '--json'], {
      resolveInstalledRoleName: () => { resolved = true; return 'architect'; },
      probeCodexVersionDetailed: () => {
        probeCalls += 1;
        return { status: 'ok', collected: { output: 'codex-cli 0.146.1\n', truncated: false, lineLimitExceeded: false } };
      },
    });
    assert.equal(result.exitCode, 1);
    assert.equal(resolved, false);
    assert.equal(probeCalls, 1);
    assert.deepEqual(result.stderr, []);
    assert.deepEqual(JSON.parse(result.stdout.join('\n')), {
      ok: false,
      reason: 'unsupported_documented_leader_proof',
      diagnostics: {
        probe_status: 'ok',
        detected_version: '0.146.1',
        documented_root_identity: { status: 'missing' },
      },
    });
  });

  it('validates malformed arguments before resolving a role', async () => {
    let resolved = false;
    await assert.rejects(() => invoke(['role-intent', 'write', '--role', 'architect', '--json'], {
      resolveInstalledRoleName: () => { resolved = true; return 'architect'; },
    }), /Missing --parent-thread/);
    assert.equal(resolved, false);
  });

  it('keeps unknown-role precedence without consulting an authority state source', async () => {
    const result = await invoke(['role-intent', 'write', '--role', 'synthetic-unknown', '--parent-thread', 'forged-parent', '--json'], {
      resolveInstalledRoleName: () => null,
    });
    assert.equal(result.exitCode, 1);
    assert.deepEqual(JSON.parse(result.stdout.join('\n')), { ok: false, reason: 'unknown_role' });
  });

  it('denies an installed role without consulting forgeable authority state', async () => {
    const result = await invoke(['role-intent', 'write', '--role', 'architect', '--parent-thread', 'forged-parent', '--session', 'forged-session', '--ttl-ms', '1', '--json'], {
      resolveInstalledRoleName: (role) => role === 'architect' ? role : null,
    });
    assert.equal(result.exitCode, 1);
    assert.deepEqual(result.stderr, []);
    assert.deepEqual(JSON.parse(result.stdout.join('\n')), { ok: false, reason: 'unsupported_documented_leader_proof' });
  });

  it('normalizes prefixed and bare reviewed versions with first-token precedence', async () => {
    for (const [output, expected] of [
      ['codex-cli 0.145.0', '0.145.0'],
      ['codex 0.145.0', '0.145.0'],
      ['0.145.0', '0.145.0'],
      ['v0.146.1', '0.146.1'],
      ['0.145.0\n0.144.5', '0.145.0'],
    ] as const) {
      const result = await invoke(['preflight', '--json'], {
        probeCodexVersionDetailed: () => ({ status: 'ok', collected: { output, truncated: false, lineLimitExceeded: false } }),
      });
      const body = JSON.parse(result.stdout.join('\n'));
      assert.equal(body.diagnostics.detected_version, expected);
      assert.equal(body.diagnostics.documented_root_identity.status, 'missing');
    }
  });

  it('keeps malformed, future, and over-limit diagnostics non-authorizing', async () => {
    const cases = [
      { status: 'ok', collected: { output: 'codex-cli malformed', truncated: false, lineLimitExceeded: false } },
      { status: 'ok', collected: { output: 'codex-cli 0.147.0', truncated: false, lineLimitExceeded: false } },
      { status: 'ok', collected: { output: 'codex-cli 0.146.1', truncated: true, lineLimitExceeded: false } },
      { status: 'ok', collected: { output: 'codex-cli 0.146.1', truncated: false, lineLimitExceeded: true } },
    ] as const;
    for (const probeResult of cases) {
      const result = await invoke(['preflight', '--json'], {
        probeCodexVersionDetailed: () => probeResult,
      });
      const body = JSON.parse(result.stdout.join('\n'));
      assert.equal(body.diagnostics.documented_root_identity.status, 'unknown');
      if (probeResult.status === 'ok' && (probeResult.collected.truncated || probeResult.collected.lineLimitExceeded)) {
        assert.equal(body.diagnostics.detected_version, null);
      }
    }
  });

  it('maps injected null and throws to deterministic exit-failure without retrying', async () => {
    let nullCalls = 0;
    const nullResult = await invoke(['preflight', '--json'], {
      probeCodexVersionDetailed: () => { nullCalls += 1; return null; },
    });
    assert.equal(nullCalls, 1);
    assert.equal(JSON.parse(nullResult.stdout.join('\n')).diagnostics.probe_status, 'exit-failure');

    let throwCalls = 0;
    const throwResult = await invoke(['preflight'], {
      probeCodexVersionDetailed: () => { throwCalls += 1; throw new Error('probe failed'); },
    });
    assert.equal(throwCalls, 1);
    assert.deepEqual(throwResult.stderr, [
      'ralplan preflight failed: unsupported_documented_leader_proof',
      'detected codex null; probe_status: exit-failure; documented_root_identity: unknown',
    ]);
  });
});
