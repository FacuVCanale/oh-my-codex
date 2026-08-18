import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  resolveAuthoritativeTeamWorkerContext,
  resolveConductorPolicyRoot,
  type AuthoritativeTeamWorkerEvidence,
} from "../worker-provenance.js";

async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(join(path, ".."), { recursive: true });
  await writeFile(path, JSON.stringify(value, null, 2));
}

interface TeamFixture {
  leaderCwd: string;
  stateRoot: string;
  workerCwd: string;
  teamName: string;
  workerName: string;
  paneId: string;
  env: NodeJS.ProcessEnv;
}

async function createTeamFixture(options: { withSessionsDir?: boolean } = {}): Promise<{ root: string; fixture: TeamFixture }> {
  const root = await mkdtemp(join(tmpdir(), "omx-3536-provenance-"));
  const canonicalRoot = realpathSync(root);
  const leaderCwd = join(canonicalRoot, "leader");
  const stateRoot = join(canonicalRoot, "external", ".omx", "state");
  const teamName = "ext-team";
  const workerName = "worker-1";
  const paneId = "%77";
  const workerCwd = join(leaderCwd, ".omx", "team", teamName, "worktrees", workerName);
  await mkdir(workerCwd, { recursive: true });
  if (options.withSessionsDir !== false) {
    await mkdir(join(stateRoot, "sessions"), { recursive: true });
  }
  const teamRoot = join(stateRoot, "team", teamName);
  await writeJson(join(teamRoot, "workers", workerName, "identity.json"), {
    name: workerName,
    index: 1,
    role: "executor",
    assigned_tasks: ["1"],
    pane_id: paneId,
    worktree_path: workerCwd,
    team_state_root: stateRoot,
  });
  const metadata = {
    name: teamName,
    leader_cwd: leaderCwd,
    team_state_root: stateRoot,
    leader_pane_id: "%42",
    workers: [{ name: workerName, pane_id: paneId, worktree_path: workerCwd, team_state_root: stateRoot }],
  };
  await writeJson(join(teamRoot, "manifest.v2.json"), metadata);
  await writeJson(join(teamRoot, "config.json"), metadata);
  return {
    root,
    fixture: {
      leaderCwd,
      stateRoot,
      workerCwd,
      teamName,
      workerName,
      paneId,
      env: {
        TMUX: "1",
        TMUX_PANE: paneId,
        OMX_TEAM_INTERNAL_WORKER: `${teamName}/${workerName}`,
        OMX_TEAM_WORKER: `${teamName}/${workerName}`,
        OMX_TEAM_STATE_ROOT: stateRoot,
        OMX_TEAM_LEADER_CWD: leaderCwd,
      },
    },
  };
}

describe("resolveAuthoritativeTeamWorkerContext (#3536)", () => {
  it("returns typed evidence for a fully verified external-root worker", async () => {
    const { root, fixture } = await createTeamFixture();
    try {
      const evidence = await resolveAuthoritativeTeamWorkerContext(fixture.workerCwd, { env: fixture.env });
      assert.ok(evidence);
      assert.equal(evidence.teamName, fixture.teamName);
      assert.equal(evidence.workerName, fixture.workerName);
      assert.equal(evidence.canonicalStateRoot, realpathSync(fixture.stateRoot));
      assert.equal(evidence.canonicalLeaderCwd, fixture.leaderCwd);
      assert.equal(evidence.canonicalWorkerCwd, fixture.workerCwd);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("verifies pane identity when required", async () => {
    const { root, fixture } = await createTeamFixture();
    try {
      const ok = await resolveAuthoritativeTeamWorkerContext(fixture.workerCwd, { env: fixture.env, requireWorkerPane: true });
      assert.ok(ok);
      const denied = await resolveAuthoritativeTeamWorkerContext(fixture.workerCwd, {
        env: { ...fixture.env, TMUX_PANE: "%99" },
        requireWorkerPane: true,
      });
      assert.equal(denied, null);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("denies mismatched leader CWD instead of trusting bare OMX_TEAM_LEADER_CWD", async () => {
    const { root, fixture } = await createTeamFixture();
    try {
      const denied = await resolveAuthoritativeTeamWorkerContext(fixture.workerCwd, {
        env: { ...fixture.env, OMX_TEAM_LEADER_CWD: join(root, "elsewhere") },
      });
      assert.equal(denied, null);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("denies mismatched state root, internal identity, worktree, config, and manifest", async () => {
    const { root, fixture } = await createTeamFixture();
    try {
      const foreignRoot = join(root, "foreign-state");
      await mkdir(join(foreignRoot, "sessions"), { recursive: true });
      assert.equal(
        await resolveAuthoritativeTeamWorkerContext(fixture.workerCwd, { env: { ...fixture.env, OMX_TEAM_STATE_ROOT: foreignRoot } }),
        null,
        "state root mismatch",
      );
      assert.equal(
        await resolveAuthoritativeTeamWorkerContext(fixture.workerCwd, { env: { ...fixture.env, OMX_TEAM_INTERNAL_WORKER: `${fixture.teamName}/worker-2` } }),
        null,
        "internal identity mismatch",
      );
      assert.equal(
        await resolveAuthoritativeTeamWorkerContext(join(root, "other-worktree"), { env: fixture.env }),
        null,
        "worktree mismatch",
      );

      const teamRoot = join(fixture.stateRoot, "team", fixture.teamName);
      const configPath = join(teamRoot, "config.json");
      const original = JSON.parse(await readFile(configPath, "utf-8"));
      original.leader_cwd = join(root, "tampered-leader");
      await writeFile(configPath, JSON.stringify(original));
      assert.equal(
        await resolveAuthoritativeTeamWorkerContext(fixture.workerCwd, { env: fixture.env }),
        null,
        "config/manifest leader_cwd conflict",
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("matches canonical path aliases for the state root (symlink alias)", async () => {
    const { root, fixture } = await createTeamFixture();
    try {
      const alias = join(root, "state-alias");
      await symlink(fixture.stateRoot, alias);
      const evidence = await resolveAuthoritativeTeamWorkerContext(fixture.workerCwd, {
        env: { ...fixture.env, OMX_TEAM_STATE_ROOT: alias },
      });
      assert.ok(evidence, "aliased root still verifies through canonical comparison");
      assert.equal(evidence.canonicalStateRoot, realpathSync(fixture.stateRoot));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("resolveConductorPolicyRoot (#3536)", () => {
  it("binds a verified external Team state root to the verified leader CWD", async () => {
    const { root, fixture } = await createTeamFixture();
    try {
      const evidence = await resolveAuthoritativeTeamWorkerContext(fixture.workerCwd, { env: fixture.env });
      assert.ok(evidence);
      const bound = resolveConductorPolicyRoot(fixture.stateRoot, fixture.workerCwd, evidence);
      assert.equal(bound.valid, true);
      assert.equal(bound.teamWorkerBound, true);
      assert.equal(bound.externalStateRoot, true);
      assert.equal(bound.cwd, fixture.leaderCwd);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("keeps the same external root fail-closed without verified evidence", async () => {
    const { root, fixture } = await createTeamFixture();
    try {
      const resolution = resolveConductorPolicyRoot(fixture.stateRoot, fixture.workerCwd, null);
      assert.equal(resolution.valid, false);
      assert.equal(resolution.statePresent, true);
      assert.equal(resolution.externalStateRoot, true);
      assert.equal(resolution.teamWorkerBound, false);
      assert.equal(resolution.cwd, realpathSync(fixture.workerCwd));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects verified evidence bound to a different root (no cross-root alias)", async () => {
    const { root, fixture } = await createTeamFixture();
    try {
      const evidence = await resolveAuthoritativeTeamWorkerContext(fixture.workerCwd, { env: fixture.env });
      assert.ok(evidence);
      const otherRoot = join(root, "other-state");
      await mkdir(join(otherRoot, "sessions"), { recursive: true });
      const resolution = resolveConductorPolicyRoot(otherRoot, fixture.workerCwd, evidence);
      assert.equal(resolution.valid, false);
      assert.equal(resolution.teamWorkerBound, false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("keeps existing valid resolutions ahead of team evidence (no override)", async () => {
    const { root, fixture } = await createTeamFixture();
    try {
      const evidence = await resolveAuthoritativeTeamWorkerContext(fixture.workerCwd, { env: fixture.env });
      assert.ok(evidence);
      // Root session.json with a canonical cwd keeps precedence.
      const sessionRoot = join(root, "session-root");
      await mkdir(sessionRoot, { recursive: true });
      await writeJson(join(sessionRoot, "session.json"), { cwd: fixture.leaderCwd });
      const withSession = resolveConductorPolicyRoot(sessionRoot, fixture.workerCwd, evidence);
      assert.equal(withSession.valid, true);
      assert.equal(withSession.teamWorkerBound, false);
      assert.equal(withSession.cwd, fixture.leaderCwd);
      // Default in-repo state root behavior is unchanged.
      const inRepo = resolveConductorPolicyRoot(join(fixture.leaderCwd, ".omx", "state"), fixture.leaderCwd, null);
      assert.equal(inRepo.valid, true);
      assert.equal(inRepo.externalStateRoot, false);
      assert.equal(inRepo.teamWorkerBound, false);
      assert.equal(inRepo.cwd, fixture.leaderCwd);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("binds through a symlink-aliased selected stateDir via canonical equality", async () => {
    const { root, fixture } = await createTeamFixture();
    try {
      const alias = join(root, "state-alias");
      await symlink(fixture.stateRoot, alias);
      const evidence = await resolveAuthoritativeTeamWorkerContext(fixture.workerCwd, {
        env: { ...fixture.env, OMX_TEAM_STATE_ROOT: alias },
      });
      assert.ok(evidence);
      const bound = resolveConductorPolicyRoot(alias, fixture.workerCwd, evidence);
      assert.equal(bound.valid, true);
      assert.equal(bound.teamWorkerBound, true);
      assert.equal(bound.cwd, fixture.leaderCwd);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("treats fabricated evidence for a foreign root as invalid", async () => {
    const { root, fixture } = await createTeamFixture();
    try {
      const foreignRoot = join(root, "fabricated");
      await mkdir(join(foreignRoot, "sessions"), { recursive: true });
      const fabricated: AuthoritativeTeamWorkerEvidence = {
        teamName: fixture.teamName,
        workerName: fixture.workerName,
        stateRoot: join(root, "not-the-selected-root"),
        canonicalStateRoot: join(root, "not-the-selected-root"),
        canonicalLeaderCwd: fixture.leaderCwd,
        canonicalWorkerCwd: fixture.workerCwd,
      };
      const resolution = resolveConductorPolicyRoot(foreignRoot, fixture.workerCwd, fabricated);
      assert.equal(resolution.valid, false);
      assert.equal(resolution.teamWorkerBound, false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
