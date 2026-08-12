import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { WAVE_TWO_CONTRACTS } from '../prompt-guidance-contract.js';
import { assertContractSurface, loadSurface } from './prompt-guidance-test-helpers.js';

describe('prompt guidance wave two contract', () => {
  for (const contract of WAVE_TWO_CONTRACTS) {
    it(`${contract.id} satisfies the wave-two contract`, () => {
      assertContractSurface(contract);
    });
  }

  it('wave-two prompts encode role-appropriate grounded-evidence wording', () => {
    assert.match(loadSurface('prompts/architect.md'), /analysis is grounded/i);
    assert.match(loadSurface('prompts/critic.md'), /verdict is grounded/i);
    assert.match(loadSurface('prompts/debugger.md'), /diagnosis is grounded/i);
    assert.match(loadSurface('prompts/test-engineer.md'), /recommendation is grounded/i);
    assert.match(loadSurface('prompts/code-reviewer.md'), /review is grounded/i);
    assert.match(loadSurface('prompts/quality-reviewer.md'), /evidence-backed findings/i);
    assert.match(loadSurface('prompts/code-reviewer.md'), /review is grounded/i);
    assert.match(loadSurface('prompts/researcher.md'), /citation sufficiency/i);
    assert.match(loadSurface('prompts/explore.md'), /answer is grounded/i);
  });

  it('researcher encodes a docs-first technical research workflow', () => {
    const researcher = loadSurface('prompts/researcher.md');
    assert.match(researcher, /classify the request/i);
    assert.match(researcher, /authoritative docs structure.*smallest set of pages/i);
    assert.match(researcher, /examples that add value after docs grounding/i);
    assert.match(researcher, /source-reference evidence/i);
    assert.match(researcher, /Current best-practice research/i);
    assert.match(researcher, /official documentation.*upstream guidance/i);
  });

  it('researcher exposes concise cross-repo OSS research capability with structured citations', () => {
    const researcher = loadSurface('prompts/researcher.md');
    assert.match(researcher, /org\/repo@sha:path/i, 'researcher must specify the org/repo@sha:path:line citation format');
    assert.match(researcher, /OSS Reference Implementations/, 'researcher output_contract must include the OSS Reference Implementations section');
    assert.match(researcher, /never a moving branch/i, 'researcher must forbid moving-branch citations in OSS evidence');
    assert.match(researcher, /already chosen technology/i, 'researcher must keep the already-chosen-technology scope guard');
    assert.match(researcher, /repo-local usage.*`explore`/i, 'researcher must route local-repo inspection to explore');
  });

  it('research specialists keep explicit output-contract fixtures for source preference and boundary discipline', () => {
    const researcher = loadSurface('prompts/researcher.md');
    const dependencyExpert = loadSurface('prompts/dependency-expert.md');
    const explore = loadSurface('prompts/explore.md');

    assert.match(researcher, /source URL/i);
    assert.match(researcher, /Prefer official documentation/i);
    assert.match(researcher, /Version compatibility or version uncertainty is noted when relevant|### Version Note/i);
    assert.match(researcher, /version\/date certainty/i);
    assert.match(researcher, /supplemental/i);
    assert.match(researcher, /already chosen technology/i);
    assert.match(researcher, /Route package\/SDK adoption.*to `dependency-expert`/i);

    assert.match(dependencyExpert, /at least two credible candidates/i);
    assert.match(dependencyExpert, /license requirements|license sources/i);
    assert.match(dependencyExpert, /release and commit activity|adoption\/download signals/i);
    assert.match(dependencyExpert, /Risks/i);
    assert.match(dependencyExpert, /adoption, upgrade, replacement, or migration decision/i);
    assert.match(dependencyExpert, /route it to `researcher`/i);

    assert.match(explore, /ALL paths are absolute/i);
    assert.match(explore, /Relationships between files\/patterns explained/i);
    assert.match(explore, /Read-only/i);
    assert.match(explore, /repo-local facts only/i);
    assert.match(explore, /dependency recommendation.*report that handoff upward|report that handoff upward/i);
  });

  it('code-reviewer rejects masking fallback and workaround patches unless narrowly justified', () => {
    const codeReviewer = loadSurface('prompts/code-reviewer.md');

    assert.match(codeReviewer, /Root-cause guard/i);
    assert.match(codeReviewer, /fallback\/workaround code as a blocker when it masks failures/i);
    assert.match(codeReviewer, /Never approve CRITICAL or HIGH findings/i);
    assert.match(codeReviewer, /Preserve evidence for uncertain findings/i);
    assert.match(codeReviewer, /narrow compatibility fallback is acceptable/i);
    assert.match(codeReviewer, /minimal root-cause repair/i);
  });

  it('code-review and verifier-adjacent prompts preserve merge-if-green as downstream context', () => {
    assert.match(loadSurface('prompts/critic.md'), /later workflow condition|downstream context/i);
    assert.match(loadSurface('prompts/test-engineer.md'), /merge if CI green/i);
  });
});
