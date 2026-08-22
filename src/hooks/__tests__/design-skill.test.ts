import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { classifyKeywordInput, detectPrimaryKeyword } from '../keyword-detector.js';

const repoRoot = new URL('../../..', import.meta.url).pathname;
const designSkill = readFileSync(join(repoRoot, 'skills', 'design', 'SKILL.md'), 'utf-8');
const visualRalphSkill = readFileSync(join(repoRoot, 'skills', 'visual-ralph', 'SKILL.md'), 'utf-8');

describe('design skill contract', () => {
  it('defines canonical DESIGN.md source-of-truth workflow', () => {
    assert.match(designSkill, /^---\nname: design/m);
    assert.match(designSkill, /discover product and UI evidence/i);
    assert.match(designSkill, /durable `DESIGN\.md` contract/i);
    assert.match(designSkill, /It is a maintained design brief/i);
    assert.match(designSkill, /## Workflow/i);
    assert.match(designSkill, /Discover local evidence/i);
    assert.match(designSkill, /Interview only missing context/i);
    assert.match(designSkill, /Create or refresh `DESIGN\.md`/i);
  });

  it('requires the DESIGN.md checklist sections from issue 2277', () => {
    for (const section of [
      'Brand',
      'Product goals',
      'Personas and jobs',
      'Information architecture',
      'Design principles',
      'Visual language',
      'Components',
      'Accessibility',
      'Responsive behavior',
      'Interaction states',
      'Content voice',
      'Implementation constraints',
      'Open questions',
    ]) {
      assert.match(designSkill, new RegExp(`## ${section.replace(/[.*+?^${}()|[\\]\\]/g, '\\$&')}`, 'i'));
    }
  });

  it('separates design governance from Visual Ralph matching', () => {
    assert.match(designSkill, /`\$design` owns product goals, users, information architecture, visual language, components, accessibility, constraints, and open questions/i);
    assert.match(designSkill, /`\$visual-ralph` owns implementation against an approved visual reference or live-URL baseline/i);
    assert.match(designSkill, /`DESIGN\.md` supports but does not replace the visual verdict target/i);
    assert.doesNotMatch(visualRalphSkill, /use `\$frontend-ui-ux`/i);
    assert.match(visualRalphSkill, /durable `DESIGN\.md` brief \(`\$design`\)/i);
  });

  it('routes explicit $design and treats removed $frontend-ui-ux as sunset stub', () => {
    const design = detectPrimaryKeyword('$design refresh our design docs');
    assert.ok(design);
    assert.equal(design.skill, 'design');

    const removed = classifyKeywordInput('$frontend-ui-ux improve this page');
    assert.equal(removed.matches.length, 0);
    assert.equal(removed.removedMatches.length, 1);
    assert.match(removed.removedMatches[0].message, /removed/i);
    assert.match(removed.removedMatches[0].message, /use.*\$design/i);
  });
});
