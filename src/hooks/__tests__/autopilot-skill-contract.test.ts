import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const autopilotSkill = readFileSync(join(__dirname, '../../../skills/autopilot/SKILL.md'), 'utf-8');
const ralplanSkill = readFileSync(join(__dirname, '../../../skills/ralplan/SKILL.md'), 'utf-8');
const codeReviewSkill = readFileSync(join(__dirname, '../../../skills/code-review/SKILL.md'), 'utf-8');
const ultragoalSkill = readFileSync(join(__dirname, '../../../skills/ultragoal/SKILL.md'), 'utf-8');
const pipelineSkill = readFileSync(join(__dirname, '../../../skills/pipeline/SKILL.md'), 'utf-8');
const ralphSkill = readFileSync(join(__dirname, '../../../skills/ralph/SKILL.md'), 'utf-8');
const ultraworkSkill = readFileSync(join(__dirname, '../../../skills/ultrawork/SKILL.md'), 'utf-8');
const skillsDocs = readFileSync(join(__dirname, '../../../docs/skills.html'), 'utf-8');
const gettingStartedDocs = readFileSync(join(__dirname, '../../../docs/getting-started.html'), 'utf-8');
const guidanceRoot = join(__dirname, '../../..');
const authorityGuidanceSurfaces = [
  'docs/codex-native-hooks.md',
  'docs/adr/3194-codex-01445-documented-leader-proof.md',
  'skills/ralplan/SKILL.md',
  'plugins/oh-my-codex/skills/ralplan/SKILL.md',
] as const;

describe('execution-loop sunset stub contract', () => {
  it('autopilot is a sunset stub pointing to the default lightweight workflow', () => {
    assert.match(autopilotSkill, /was removed/i);
    assert.match(autopilotSkill, /understand -> execute -> verify -> report/i);
  });

  it('ralph is a sunset stub pointing to ultragoal', () => {
    assert.match(ralphSkill, /was removed/i);
    assert.match(ralphSkill, /\$ultragoal/i);
  });

  it('ultrawork is a sunset stub pointing to team', () => {
    assert.match(ultraworkSkill, /was removed/i);
    assert.match(ultraworkSkill, /\$team/i);
  });

  it('pipeline is a sunset stub pointing to plan and team', () => {
    assert.match(pipelineSkill, /was removed/i);
    assert.match(pipelineSkill, /\$plan/i);
    assert.match(pipelineSkill, /\$team/i);
  });

  it('documents minimal state/HUD contracts for code-review and ultragoal child phases', () => {
    assert.match(codeReviewSkill, /State\/HUD Phase Contract/);
    assert.match(codeReviewSkill, /not a standalone tracked mode with a `code-review-state\.json` lifecycle/i);
    assert.match(codeReviewSkill, /skill-active-state\.json.*skill:"code-review".*phase:"planning"/s);
    assert.match(codeReviewSkill, /current_phase":"code-review"/);
    assert.match(ultragoalSkill, /State\/HUD Phase Contract/);
    assert.match(ultragoalSkill, /mode:"ultragoal".*active:true.*current_phase/s);
    assert.match(ultragoalSkill, /current_phase":"ultragoal"/);
    assert.match(ultragoalSkill, /handoff_artifacts\.ultragoal/);
  });

  it('requires ralplan sunset stub (merged into plan)', () => {
    assert.match(ralplanSkill, /was removed/i);
    assert.match(ralplanSkill, /\$plan/i);
    assert.doesNotMatch(ralplanSkill, /subsequent role-specific `Architect` subagent/i);
  });

  it('keeps documented-leader preflight capability-scoped across public guidance', () => {
    // ralplan is now a sunset stub — skip its content check; verify remaining surfaces still contain authority guidance where present
    const nonStubSurfaces = authorityGuidanceSurfaces.filter((p) => p !== 'skills/ralplan/SKILL.md' && p !== 'plugins/oh-my-codex/skills/ralplan/SKILL.md');
    for (const path of nonStubSurfaces) {
      const content = readFileSync(join(guidanceRoot, path), 'utf-8');
      assert.match(content, /role_routing_unavailable/);
      assert.match(content, /adapted Ralplan/i);
      assert.match(content, /Ordinary native planning[\s\S]*outside this preflight boundary/i);
      assert.doesNotMatch(content, /before (substantive )?planning, reviewer delegation, HUD\/runtime activation/i);
    }
    // ralplan stubs should point to successor
    for (const path of ['skills/ralplan/SKILL.md']) {
      const content = readFileSync(join(guidanceRoot, path), 'utf-8');
      assert.match(content, /was removed/i);
      assert.match(content, /\$plan/i);
    }

    for (const path of ['docs/release-notes-0.20.2.md', 'docs/release-notes-0.20.3.md', 'CHANGELOG.md', 'RELEASE_BODY.md']) {
      const content = readFileSync(join(guidanceRoot, path), 'utf-8');
      assert.match(content, /Current status \/ supersession/);
      assert.match(content, /unsupported_documented_leader_proof/);
      assert.match(content, /documented_host_consensus_receipt_unavailable/);
    }
  });

  it('public docs no longer advertise the removed fixed chain or removed skills', () => {
    // skills.html and getting-started.html should not advertise autopilot's fixed chain
    assert.doesNotMatch(skillsDocs, /\$deep-interview\s*->\s*\$ralplan\s*->\s*\$ultragoal.*\$code-review\s*->\s*\$ultraqa/);
    assert.doesNotMatch(gettingStartedDocs, /Choose `\$autopilot`.*`\$ultrawork`.*`\$ralph`/);
  });

  it('autopilot stub does not preserve the old broad phase lifecycle', () => {
    assert.doesNotMatch(autopilotSkill, /All 5 phases completed/i);
    assert.doesNotMatch(autopilotSkill, /Phase 0 - Expansion/i);
    assert.doesNotMatch(autopilotSkill, /Phase 4 - Validation/i);
  });
});
