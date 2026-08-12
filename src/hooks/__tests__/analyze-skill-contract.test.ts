import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const analyzeSkill = readFileSync(
  join(__dirname, '../../../skills/analyze/SKILL.md'),
  'utf-8',
);

describe('analyze skill contract', () => {
  it('keeps analysis read-only and aligned to the repository question', () => {
    assert.match(analyzeSkill, /^---\nname: analyze/m);
    assert.match(analyzeSkill, /grounded, read-only evidence/i);
    assert.match(analyzeSkill, /Explain what the code most likely says/i);
    assert.match(analyzeSkill, /do not turn analysis into implementation or generic fix planning/i);
    assert.match(analyzeSkill, /The answer requires tracing multiple files or boundaries/i);
    assert.match(analyzeSkill, /Do not use it for edits, implementation/i);
  });

  it('distinguishes evidence, inference, and unresolved unknowns', () => {
    assert.match(analyzeSkill, /## Evidence discipline/i);
    assert.match(analyzeSkill, /\*\*Evidence\*\* — directly shown by code, tests, generated artifacts, configuration, or docs/i);
    assert.match(analyzeSkill, /\*\*Inference\*\* — a reasoned conclusion drawn from cited evidence/i);
    assert.match(analyzeSkill, /\*\*Unknown\*\* — not settled by the repository evidence/i);
    assert.match(analyzeSkill, /Never present guesses as evidence or inference/i);
    assert.match(analyzeSkill, /never overclaim certainty/i);
    assert.match(analyzeSkill, /Prefer direct paths and independent corroboration/i);
  });

  it('requires a bounded investigation method and ranked synthesis output', () => {
    assert.match(analyzeSkill, /Restate the question and define the evidence-backed scope/i);
    assert.match(analyzeSkill, /Identify the smallest files, tests, configs, and docs/i);
    assert.match(analyzeSkill, /Read direct code paths and contracts first/i);
    assert.match(analyzeSkill, /Compare competing explanations, rank them by support/i);
    assert.match(analyzeSkill, /Stop when the question is answered with sufficient evidence/i);
    assert.match(analyzeSkill, /### Question/i);
    assert.match(analyzeSkill, /### Ranked synthesis/i);
    assert.match(analyzeSkill, /\| Rank \| Explanation \| Confidence \| Basis \|/i);
    assert.match(analyzeSkill, /### Evidence/i);
    assert.match(analyzeSkill, /### Inference/i);
    assert.match(analyzeSkill, /### Unknowns \/ limits/i);
    assert.match(analyzeSkill, /path\/to\/file:line-line/i);
  });
});
