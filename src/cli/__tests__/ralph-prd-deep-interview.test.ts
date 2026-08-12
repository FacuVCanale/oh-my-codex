import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ralphSkill = readFileSync(join(__dirname, '../../../skills/ralph/SKILL.md'), 'utf-8');

describe('ralph sunset stub', () => {
  it('ralph is a sunset stub pointing to ultragoal', () => {
    assert.match(ralphSkill, /was removed/i);
    assert.match(ralphSkill, /\$ultragoal/i);
  });
});
