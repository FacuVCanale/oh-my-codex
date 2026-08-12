import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildRalphAppendInstructions } from '../ralph.js';
import {
  LEADER_CONDUCTOR_BLOCK,
  LEADER_CONDUCTOR_GOLDEN_RULE,
  LEADER_CONDUCTOR_REUSE_AND_LEDGER_GUIDANCE,
} from '../../leader/contract.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ralphSkill = readFileSync(join(__dirname, '../../../skills/ralph/SKILL.md'), 'utf-8');

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

describe('ralph sunset stub and goal mode runtime', () => {
  it('ralph is a sunset stub pointing to ultragoal', () => {
    assert.match(ralphSkill, /was removed/i);
    assert.match(ralphSkill, /\$ultragoal/i);
  });

  it('injects goal-mode guidance into launched Ralph sessions', () => {
    const instructions = buildRalphAppendInstructions('ship the integration', {
      changedFilesPath: '.omx/ralph/changed-files.txt',
      noDeslop: false,
    });

    assert.match(instructions, /Goal mode guidance/i);
    assert.match(instructions, /Conductor philosophy:/i);
    assert.match(instructions, new RegExp(escapeRegExp(LEADER_CONDUCTOR_BLOCK)));
    assert.match(instructions, new RegExp(escapeRegExp(LEADER_CONDUCTOR_GOLDEN_RULE)));
    assert.match(instructions, new RegExp(escapeRegExp(LEADER_CONDUCTOR_REUSE_AND_LEDGER_GUIDANCE)));
    assert.match(instructions, /get_goal/i);
    assert.match(instructions, /create_goal/i);
    assert.match(instructions, /update_goal\(\{status: "complete"\}\)/i);
    assert.match(instructions, /top-level completion contract/i);
    assert.match(instructions, /prompt-to-artifact checklist/i);
    assert.match(instructions, /completion_audit\.passed=true/i);
    assert.match(instructions, /completion_audit\.verification_evidence/i);
  });
});
