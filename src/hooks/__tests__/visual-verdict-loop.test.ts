import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { classifyKeywordInput } from '../keyword-detector.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

describe('removed visual-verdict sunset stub', () => {
  it('surfaces sunset stub for removed visual-verdict', () => {
    const c = classifyKeywordInput('$visual-verdict do visual check');
    assert.equal(c.removedMatches.length, 1);
    assert.match(c.removedMatches[0].message, /removed/i);
    assert.match(c.removedMatches[0].message, /use.*\$visual-ralph/i);
  });
});

describe('ralph visual loop integration guidance', () => {
  it('documents ralph as sunset stub pointing to ultragoal', () => {
    const ralphSkill = readFileSync(join(__dirname, '../../../skills/ralph/SKILL.md'), 'utf-8');
    assert.match(ralphSkill, /was removed/i);
    assert.match(ralphSkill, /\$ultragoal/i);
    const ultragoalSkill = readFileSync(join(__dirname, '../../../skills/ultragoal/SKILL.md'), 'utf-8');
    // Ultragoal inherits ralph-like verified loop; verify ultragoal remains present
    assert.match(ultragoalSkill, /ultragoal/i);
  });

  it('keeps Visual Ralph skill for visual QA independent of ralph sunset', () => {
    const visualRalph = readFileSync(join(__dirname, '../../../skills/visual-ralph/SKILL.md'), 'utf-8');
    assert.match(visualRalph, /visual/i);
  });
});
