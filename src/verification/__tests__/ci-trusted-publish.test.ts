import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

function readCiWorkflow(): string {
  const workflowPath = join(process.cwd(), '.github', 'workflows', 'ci.yml');
  assert.equal(existsSync(workflowPath), true, `missing workflow: ${workflowPath}`);
  return readFileSync(workflowPath, 'utf-8').replace(/\r\n/g, '\n');
}

function jobBlock(workflow: string, jobName: string): string {
  const startMatch = workflow.match(new RegExp(`(^|\n)  ${jobName}:\n`));
  assert.ok(startMatch?.index !== undefined, `missing CI job block for ${jobName}`);

  const start = startMatch.index + startMatch[1].length;
  const afterJobHeader = start + `  ${jobName}:\n`.length;
  const nextJobOffset = workflow.slice(afterJobHeader).search(/\n  [a-z0-9-]+:\n/);
  const end = nextJobOffset === -1 ? workflow.length : afterJobHeader + nextJobOffset;
  return workflow.slice(start, end);
}

const PUBLISH_JOB = 'publish-npm-trusted';

describe('CI npm trusted publishing contract', () => {

  it('exposes a manual dispatch input for an immutable release tag only', () => {
    const workflow = readCiWorkflow();

    assert.match(workflow, /workflow_dispatch:\n\s+inputs:\n\s+release_tag:/);
    // The dispatch input is optional so ordinary CI events never treat it as set.
    assert.match(workflow, /release_tag:\n\s+description: 'Immutable release tag to publish via npm trusted publishing, e\.g\. v0\.21\.0'\n\s+required: false\n\s+type: string/);
  });

  it('runs the publish job only on an explicit dispatch from main with a tag input', () => {
    const publishJob = jobBlock(readCiWorkflow(), PUBLISH_JOB);

    // Ordinary push and pull_request CI must never run the publish job.
    assert.match(
      publishJob,
      /if: github\.event_name == 'workflow_dispatch' && github\.ref == 'refs\/heads\/main' && inputs\.release_tag != ''/,
    );
    // The publish job must not be reachable through the shared lane outputs.
    assert.doesNotMatch(publishJob, /needs\.changes/);
    assert.doesNotMatch(publishJob, /needs:/);
  });

  it('grants only the OIDC and read permissions trusted publishing needs', () => {
    const publishJob = jobBlock(readCiWorkflow(), PUBLISH_JOB);

    assert.match(publishJob, /permissions:\n\s+contents: read\n\s+id-token: write/);
    // No write surface beyond the OIDC token: contents stays read-only.
    assert.doesNotMatch(publishJob, /contents:\s*write/);
    assert.doesNotMatch(publishJob, /packages:\s*write/);
  });

  it('publishes tokenlessly with provenance and no secret or OTP fallback', () => {
    const publishJob = jobBlock(readCiWorkflow(), PUBLISH_JOB);

    assert.match(publishJob, /run: npm publish --access public --provenance\n/);

    // No npm token, no OTP, no non-provenance retry path.
    assert.doesNotMatch(publishJob, /NODE_AUTH_TOKEN/);
    assert.doesNotMatch(publishJob, /NPM_TOKEN/);
    assert.doesNotMatch(publishJob, /secrets\./);
    assert.doesNotMatch(publishJob, /_authToken/);
    assert.doesNotMatch(publishJob, /npm whoami/);
    assert.doesNotMatch(publishJob, /--otp/i);
    // The publish step must be the single tokenless attempt: no conditional retry.
    const publishSteps = publishJob.match(/npm publish[^\n]*/g) ?? [];
    assert.deepEqual(publishSteps, ['npm publish --access public --provenance']);
  });

  it('binds publication to the exact release tag and refuses mismatches', () => {
    const publishJob = jobBlock(readCiWorkflow(), PUBLISH_JOB);

    // Tag shape gate before any checkout.
    assert.match(publishJob, /\^v\[0-9\]\+\\\.\[0-9\]\+\\\.\[0-9\]\+\$/);
    // Checkout is pinned to the input tag, never the dispatch branch.
    assert.match(publishJob, /uses: actions\/checkout@v7\n\s+with:\n\s+ref: \$\{\{ inputs\.release_tag \}\}/);
    // Tag must resolve to the default branch head: no arbitrary commit publishing.
    assert.match(publishJob, /git rev-parse "\$RELEASE_TAG\^\{\}"/);
    assert.match(publishJob, /git rev-parse refs\/remotes\/origin\/main/);
    // Package version must equal the tag.
    assert.match(publishJob, /test "\$RELEASE_TAG" = "v\$VERSION"/);
  });

  it('verifies the version is absent from the registry before publishing and refuses blind retries', () => {
    const publishJob = jobBlock(readCiWorkflow(), PUBLISH_JOB);

    assert.match(publishJob, /if npm view "oh-my-codex@\$VERSION" version >\/dev\/null 2>&1; then/);
    assert.match(publishJob, /already exists on npm; refusing blind retry/);
    // Pack is a dry run only: no artifact publication outside npm publish.
    assert.match(publishJob, /run: npm pack --dry-run\n/);
  });

  it('verifies registry publication with bounded retries after publishing', () => {
    const publishJob = jobBlock(readCiWorkflow(), PUBLISH_JOB);

    assert.match(publishJob, /for i in \$\(seq 1 20\); do/);
    assert.match(publishJob, /npm view "oh-my-codex@\$VERSION" version 2>\/dev\/null \|\| true/);
    assert.match(publishJob, /npm view oh-my-codex version dist-tags --json/);
    assert.match(publishJob, /sleep 15/);
    assert.match(publishJob, /npm did not expose oh-my-codex@\$VERSION in time/);
  });

  it('keeps ordinary push and pull_request CI free of any publish surface', () => {
    const workflow = readCiWorkflow();

    // The workflow still triggers on the same ordinary CI events.
    assert.match(workflow, /push:\n\s+branches: \[main, dev, experimental\/dev\]/);
    assert.match(workflow, /pull_request:\n\s+branches: \[main, dev, experimental\/dev\]/);

    // Only the dedicated publish job may run npm publish, and only via dispatch.
    const publishMentions = workflow.match(/npm publish[^\n]*/g) ?? [];
    assert.deepEqual(publishMentions, ['npm publish --access public --provenance']);

    // No job outside the publish block may reference the dispatch input.
    const withoutPublishJob = workflow.replace(jobBlock(workflow, PUBLISH_JOB), '');
    assert.doesNotMatch(withoutPublishJob, /inputs\.release_tag/);
    assert.doesNotMatch(withoutPublishJob, /npm publish/);
  });
});
