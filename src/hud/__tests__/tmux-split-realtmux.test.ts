import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, type TestContext } from 'node:test';
import { createHudWatchPane, findHudSplitOperationMarkerPaneId } from '../tmux.js';
import { isRealTmuxAvailable, type TempTmuxSessionFixture, withTempTmuxSession } from '../../team/__tests__/tmux-test-fixture.js';

const PANE_READY_TIMEOUT_MS = 1_000;
const PANE_READY_INTERVAL_MS = 50;
const ENV_FILE_TIMEOUT_MS = 3_000;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function skipUnlessPrivateRealTmux(t: TestContext): boolean {
  if (isRealTmuxAvailable()) return true;
  assert.equal(process.env.CI, undefined, 'CI must provide tmux for the private-server HUD split regression');
  t.skip('tmux is not installed');
  return false;
}

function quoteSh(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

function parseShimTmuxArgv(contents: string): string[][] {
  return contents
    .split('tmux argv:\n')
    .slice(1)
    .map((record) => record.split('\nend tmux argv')[0]!.split('\n').filter(Boolean));
}

async function waitForPaneReady(fixture: TempTmuxSessionFixture, paneId: string): Promise<void> {
  const deadline = Date.now() + PANE_READY_TIMEOUT_MS;
  let lastState = '';
  while (Date.now() < deadline) {
    lastState = fixture.run(['display-message', '-p', '-t', paneId, '#{pane_dead}']);
    if (lastState === '0') return;
    await new Promise((resolve) => setTimeout(resolve, PANE_READY_INTERVAL_MS));
  }
  throw new Error(`timed out waiting for private tmux pane readiness: ${paneId} (${lastState})`);
}

async function waitForFileContent(filePath: string): Promise<string> {
  const deadline = Date.now() + ENV_FILE_TIMEOUT_MS;
  let lastContent = '';
  while (Date.now() < deadline) {
    try {
      lastContent = await readFile(filePath, 'utf-8');
      if (lastContent !== '') return lastContent;
    } catch {
      // The pane may not have started writing yet.
    }
    await new Promise((resolve) => setTimeout(resolve, PANE_READY_INTERVAL_MS));
  }
  throw new Error(`timed out waiting for pane env marker file: ${filePath} (last: ${JSON.stringify(lastContent)})`);
}

describe('createHudWatchPane real private-server split transaction', () => {
  it('creates a marker-tagged HUD pane and round-trips the tmux 3.2a pane_start_command', async (t) => {
    if (!skipUnlessPrivateRealTmux(t)) return;

    const workDir = await mkdtemp(join(tmpdir(), 'omx-hud-split-realtmux-'));
    const bin = join(workDir, 'bin');
    const shimLogPath = join(workDir, 'tmux-argv.log');
    const envFile = join(workDir, 'marker-env.txt');
    const previousPath = process.env.PATH;
    try {
      await mkdir(bin, { recursive: true });
      await withTempTmuxSession({ serverLog: true }, async (fixture) => {
        await fixture.createPathShim(bin, shimLogPath);
        process.env.PATH = `${bin}:${previousPath ?? ''}`;
        try {
          await waitForPaneReady(fixture, fixture.leaderPaneId);

          const hudCmd = `/bin/sh -c ${quoteSh(
            `printf %s "$OMX_TMUX_SPLIT_OPERATION_MARKER" > ${quoteSh(envFile)}; exec sleep 300`,
          )}`;
          const paneId = createHudWatchPane(workDir, hudCmd, { targetPaneId: fixture.leaderPaneId });
          assert.ok(paneId, 'guarded split must create the HUD pane and emit its receipt');

          const panes = fixture.run(['list-panes', '-a', '-F', '#{pane_id}\t#{pane_start_command}']);
          const paneRow = panes.split('\n').find((row) => row.startsWith(`${paneId}\t`));
          assert.ok(paneRow, 'created HUD pane must exist on the private server');

          const marker = await waitForFileContent(envFile);
          assert.match(marker, UUID_PATTERN, 'env marker file must expose the operation marker uuid');
          assert.ok(
            paneRow.includes(`OMX_TMUX_SPLIT_OPERATION_MARKER='${marker}'`),
            'pane_start_command must carry the marker in the tmux 3.2a double-quoted representation',
          );

          const execTmux = (args: string[]): string => {
            const result = fixture.runResult(args);
            assert.equal(result.status, 0, `tmux ${args.join(' ')} failed: ${result.stderr}`);
            return result.stdout;
          };
          assert.equal(
            findHudSplitOperationMarkerPaneId(marker, execTmux),
            paneId,
            'marker round-trip must resolve the created HUD pane',
          );

          const ifShellTransactions = parseShimTmuxArgv(await readFile(shimLogPath, 'utf-8'))
            .filter((argv) => argv[0] === 'if-shell');
          assert.equal(ifShellTransactions.length, 1, 'guarded split must run exactly one if-shell transaction');
          const successBranch = ifShellTransactions[0]?.[5] ?? '';
          assert.match(successBranch, /split-window/);
          assert.match(successBranch, / ; display-message -p __omx_hud_split_/);
          assert.doesNotMatch(successBranch, /\\; /);
          assert.doesNotMatch(
            await fixture.readServerLog(),
            /too many arguments/i,
            'real tmux must not fold the receipt command into the effect argv',
          );
        } finally {
          if (typeof previousPath === 'string') process.env.PATH = previousPath;
          else delete process.env.PATH;
        }
      });
    } finally {
      if (typeof previousPath === 'string') process.env.PATH = previousPath;
      else delete process.env.PATH;
      await rm(workDir, { recursive: true, force: true });
    }
  });
});
