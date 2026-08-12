import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const visualVerdictSkill = readFileSync(join(__dirname, '../../../skills/visual-verdict/SKILL.md'), 'utf-8');
const ralphSkill = readFileSync(join(__dirname, '../../../skills/ralph/SKILL.md'), 'utf-8');

describe('visual-verdict skill contract', () => {
  it('hard-deprecates the standalone visual-verdict skill', () => {
    assert.match(visualVerdictSkill, /^---\nname: visual-verdict/m);
    assert.match(visualVerdictSkill, /Hard-deprecated/i);
    assert.match(visualVerdictSkill, /Do not invoke or route this skill/i);
    assert.match(visualVerdictSkill, /Use `\$visual-ralph`/i);
  });
});

describe('ralph sunset stub contract', () => {
  it('ralph is a sunset stub pointing to ultragoal', () => {
    assert.match(ralphSkill, /was removed/i);
    assert.match(ralphSkill, /\$ultragoal/i);
  });
});
