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
  it('requires the built-in Visual Ralph verdict before next edit', () => {
    const ralphSkill = readFileSync(join(__dirname, '../../../skills/ralph/SKILL.md'), 'utf-8');
    assert.match(ralphSkill, /Visual Ralph verdict step/i);
    assert.match(ralphSkill, /before every next edit/i);
  });

  it('documents -i and --images-dir flags', () => {
    const ralphSkill = readFileSync(join(__dirname, '../../../skills/ralph/SKILL.md'), 'utf-8');
    assert.match(ralphSkill, /-i <image-path>/);
    assert.match(ralphSkill, /--images-dir <directory>/);
  });

  it('requires persisting visual feedback to ralph-progress ledger', () => {
    const ralphSkill = readFileSync(join(__dirname, '../../../skills/ralph/SKILL.md'), 'utf-8');
    assert.match(ralphSkill, /ralph-progress\.json/);
    assert.match(ralphSkill, /numeric \+ qualitative feedback/i);
  });
});
