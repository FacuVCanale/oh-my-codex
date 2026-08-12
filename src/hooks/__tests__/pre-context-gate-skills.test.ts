import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

const ralplanSkill = readFileSync(
  join(__dirname, '../../../skills/ralplan/SKILL.md'),
  'utf-8',
);
const planSkill = readFileSync(
  join(__dirname, '../../../skills/plan/SKILL.md'),
  'utf-8',
);
const teamSkill = readFileSync(
  join(__dirname, '../../../skills/team/SKILL.md'),
  'utf-8',
);
const autopilotSkill = readFileSync(
  join(__dirname, '../../../skills/autopilot/SKILL.md'),
  'utf-8',
);
const ralphSkill = readFileSync(
  join(__dirname, '../../../skills/ralph/SKILL.md'),
  'utf-8',
);

describe('pre-context gate guidance in planning/execution-heavy skills', () => {
  it('ralplan is a sunset stub pointing to plan', () => {
    assert.match(ralplanSkill, /was removed/i);
    assert.match(ralplanSkill, /\$plan/i);
  });

  it('plan skill exists as canonical planning surface', () => {
    assert.match(planSkill, /plan/i);
    assert.ok(planSkill.length > 10);
  });

  it('team documents required context snapshot gate before launch', () => {
    assert.match(teamSkill, /Pre-context Intake Gate/i);
    assert.match(teamSkill, /\.omx\/context\/\{slug\}-\{timestamp\}\.md/);
    assert.match(teamSkill, /\$deep-interview\s+--quick/i);
    assert.match(teamSkill, /initialize\/sync it from canonical team runtime state before proceeding/i);
  });

  it('autopilot is a sunset stub pointing to the default lightweight workflow', () => {
    assert.match(autopilotSkill, /was removed/i);
    assert.match(autopilotSkill, /understand -> execute -> verify -> report/i);
  });

  it('ralph is a sunset stub pointing to ultragoal', () => {
    assert.match(ralphSkill, /was removed/i);
    assert.match(ralphSkill, /\$ultragoal/i);
  });
});
