import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

describe('legacy manual npm publish workflow is retired', () => {
  it('does not keep an independent token or non-provenance publish workflow', () => {
    const workflowsDir = join(process.cwd(), '.github', 'workflows');
    assert.equal(
      existsSync(join(workflowsDir, 'publish-npm-manual.yml')),
      false,
      'publish-npm-manual.yml must not remain as a dispatchable publisher',
    );

    const workflowFiles = readdirSync(workflowsDir).filter((name) => /\.ya?ml$/i.test(name));
    for (const name of workflowFiles) {
      const body = readFileSync(join(workflowsDir, name), 'utf-8').replace(/\r\n/g, '\n');
      assert.doesNotMatch(body, /name:\s*Manual npm publish/);
      assert.doesNotMatch(body, /allow_without_provenance/);
      if (name === 'ci.yml') {
        assert.doesNotMatch(body, /NODE_AUTH_TOKEN/);
        assert.doesNotMatch(body, /NPM_TOKEN/);
        assert.match(body, /npm publish --access public --provenance/);
      }
    }
  });
});
