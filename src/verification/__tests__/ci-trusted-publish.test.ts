import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

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

function extractNamedFunction(source: string, name: string): string {
  const start = source.indexOf(`function ${name}(`);
  assert.ok(start >= 0, `missing function ${name}`);
  const brace = source.indexOf('{', start);
  assert.ok(brace >= 0, `missing body for ${name}`);
  let depth = 0;
  for (let i = brace; i < source.length; i += 1) {
    const ch = source[i];
    if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(start, i + 1);
    }
  }
  assert.fail(`unclosed function ${name}`);
}

function loadFunction<T>(source: string, name: string): T {
  const fnSource = extractNamedFunction(source, name);
  return new Function(`${fnSource}\nreturn ${name};`)() as T;
}

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

const PUBLISH_JOB = 'publish-npm-trusted';

describe('CI npm trusted publishing contract', () => {

  it('exposes dispatch inputs for an immutable release tag and bound commit SHA', () => {
    const workflow = readCiWorkflow();

    assert.match(workflow, /workflow_dispatch:\n\s+inputs:\n\s+release_tag:/);
    assert.match(workflow, /release_tag:\n\s+description: 'Immutable release tag to publish via npm trusted publishing, e\.g\. v0\.21\.0'\n\s+required: false\n\s+type: string/);
    assert.match(workflow, /release_sha:\n\s+description: 'Exact peeled commit SHA the immutable release_tag must resolve to'\n\s+required: false\n\s+type: string/);
  });

  it('does not cancel a trusted-publish dispatch when ordinary CI shares main', () => {
    const workflow = readCiWorkflow();
    assert.match(
      workflow,
      /group: \$\{\{ github\.event_name == 'workflow_dispatch' && format\('ci-dispatch-\{0\}', github\.event\.inputs\.release_tag \|\| github\.run_id\) \|\| format\('ci-\{0\}', github\.ref\) \}\}/,
    );
    assert.match(workflow, /cancel-in-progress: \$\{\{ github\.event_name != 'workflow_dispatch' \}\}/);
    assert.doesNotMatch(workflow, /^\s+cancel-in-progress:\s*true$/m);
  });

  it('runs the publish job only on an explicit dispatch from main with a tag input', () => {
    const publishJob = jobBlock(readCiWorkflow(), PUBLISH_JOB);

    // Ordinary push and pull_request CI must never run the publish job.
    assert.match(
      publishJob,
      /if: github\.event_name == 'workflow_dispatch' && github\.ref == 'refs\/heads\/main' && inputs\.release_tag != '' && inputs\.release_sha != ''/,
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
    // Checkout is pinned to the input tag with full history so origin/main can be fetched.
    assert.match(
      publishJob,
      /uses: actions\/checkout@v7\n\s+with:\n\s+ref: \$\{\{ inputs\.release_tag \}\}\n\s+fetch-depth: 0\n/,
    );
    assert.match(publishJob, /git fetch --no-tags origin \+refs\/heads\/main:refs\/remotes\/origin\/main/);
    assert.match(publishJob, /git rev-parse --verify refs\/remotes\/origin\/main/);
    assert.match(publishJob, /git rev-parse "\$RELEASE_TAG\^\{\}"/);
    assert.match(publishJob, /RELEASE_SHA: \$\{\{ inputs\.release_sha \}\}/);
    assert.match(publishJob, /EXPECTED_SHA=\$\(printf '%s' "\$RELEASE_SHA" \| tr 'A-F' 'a-f'\)/);
    assert.match(publishJob, /TAG_COMMIT" != "\$EXPECTED_SHA"/);
    assert.match(publishJob, /git merge-base --is-ancestor "\$TAG_COMMIT" "\$MAIN_COMMIT"/);
    // Historical annotated tags on main must be publishable after main advances.
    assert.doesNotMatch(publishJob, /does not resolve to the main branch head/);
    assert.doesNotMatch(
      publishJob,
      /git rev-parse "\$RELEASE_TAG\^\{\}"\)" != "\$\(git rev-parse refs\/remotes\/origin\/main\)"/,
    );
    // Package version must equal the tag.
    assert.match(publishJob, /test "\$RELEASE_TAG" = "v\$VERSION"/);
  });

  it('treats an immutable tag on historical main as an ancestor, not current-head equality', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'omx-trusted-publish-ancestry-'));
    try {
      git(cwd, ['init', '-b', 'main']);
      git(cwd, ['config', 'user.email', 'trusted-publish@example.test']);
      git(cwd, ['config', 'user.name', 'trusted-publish']);
      writeFileSync(join(cwd, 'README'), 'first\n');
      git(cwd, ['add', 'README']);
      git(cwd, ['commit', '-m', 'first']);
      const tagged = git(cwd, ['rev-parse', 'HEAD']);
      git(cwd, ['tag', '-a', 'v0.21.0', '-m', 'v0.21.0']);
      writeFileSync(join(cwd, 'README'), 'first\nsecond\n');
      git(cwd, ['add', 'README']);
      git(cwd, ['commit', '-m', 'second']);
      const mainHead = git(cwd, ['rev-parse', 'HEAD']);
      const peeledTag = git(cwd, ['rev-parse', 'v0.21.0^{}']);

      assert.equal(peeledTag, tagged);
      assert.notEqual(peeledTag, mainHead);
      git(cwd, ['merge-base', '--is-ancestor', peeledTag, mainHead]);

      git(cwd, ['checkout', '-q', '-b', 'unmerged']);
      writeFileSync(join(cwd, 'README'), 'first\nsecond\nside\n');
      git(cwd, ['add', 'README']);
      git(cwd, ['commit', '-m', 'side']);
      const side = git(cwd, ['rev-parse', 'HEAD']);
      assert.throws(() => git(cwd, ['merge-base', '--is-ancestor', side, mainHead]));
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it('enforces npm >= 11.5.1 and Node >= 22.14.0, rejecting 11.5.0', () => {
    const publishJob = jobBlock(readCiWorkflow(), PUBLISH_JOB);
    assert.match(publishJob, /node-version: 24/);
    assert.match(publishJob, /npm install -g npm@\^11\.5\.1/);
    assert.match(publishJob, /npm >= 11\.5\.1 is required for tokenless trusted publishing/);
    assert.match(publishJob, /Node >= 22\.14\.0 is required for tokenless trusted publishing/);
    assert.doesNotMatch(publishJob, /npm >= 11\.5\.0 is required/);

    const nodeMeetsTrustedPublish = loadFunction<(version: string) => boolean>(
      publishJob,
      'nodeMeetsTrustedPublish',
    );
    const npmMeetsTrustedPublish = loadFunction<(version: string) => boolean>(
      publishJob,
      'npmMeetsTrustedPublish',
    );

    assert.equal(npmMeetsTrustedPublish('11.5.0'), false);
    assert.equal(npmMeetsTrustedPublish('11.4.2'), false);
    assert.equal(npmMeetsTrustedPublish('11.5.1'), true);
    assert.equal(npmMeetsTrustedPublish('11.6.0'), true);
    assert.equal(npmMeetsTrustedPublish('12.0.0'), true);
    assert.equal(nodeMeetsTrustedPublish('20.19.0'), false);
    assert.equal(nodeMeetsTrustedPublish('22.13.1'), false);
    assert.equal(nodeMeetsTrustedPublish('22.14.0'), true);
    assert.equal(nodeMeetsTrustedPublish('24.4.0'), true);
  });

  it('verifies the version is absent from the registry before publishing and refuses blind retries', () => {
    const publishJob = jobBlock(readCiWorkflow(), PUBLISH_JOB);

    assert.match(publishJob, /npm view "oh-my-codex@\$VERSION" version --json/);
    assert.match(publishJob, /already exists on npm; refusing blind retry/);
    assert.match(publishJob, /npm view failed with a non-404 registry error; refusing to publish \(fail closed\)/);
    assert.match(publishJob, /if \(code\) \{\n\s+return code === 'E404' \? 'absent' : 'error';/);
    assert.doesNotMatch(publishJob, /if npm view "oh-my-codex@\$VERSION" version >\/dev\/null 2>&1; then/);
    assert.doesNotMatch(publishJob, /code === 'E404' \|\|/);
    // Pack is a dry run only: no artifact publication outside npm publish.
    assert.match(publishJob, /run: npm pack --dry-run\n/);

    const classifyNpmViewResult = loadFunction<(status: number | string, output: string) => string>(
      publishJob,
      'classifyNpmViewResult',
    );

    assert.equal(classifyNpmViewResult(0, '"0.21.0"'), 'exists');
    assert.equal(
      classifyNpmViewResult(1, JSON.stringify({ error: { code: 'E404', summary: 'Not Found' } })),
      'absent',
    );
    assert.equal(
      classifyNpmViewResult(
        1,
        "npm error code E404\nnpm error 404 Not Found - GET https://registry.npmjs.org/oh-my-codex/0.21.0\nnpm error 404  'oh-my-codex@0.21.0' is not in this registry.\n",
      ),
      'absent',
    );
    assert.equal(
      classifyNpmViewResult(
        1,
        "npm error 404 Not Found - GET https://registry.npmjs.org/oh-my-codex/0.21.0\nnpm error 404  'oh-my-codex@0.21.0' is not in this registry.\n",
      ),
      'absent',
    );
    assert.equal(
      classifyNpmViewResult(1, JSON.stringify({ error: { code: 'E401', summary: '404 Not Found' } })),
      'error',
    );
    assert.equal(
      classifyNpmViewResult(1, 'npm error code E401\nnpm error 404 Not Found - GET https://registry.npmjs.org/oh-my-codex/0.21.0'),
      'error',
    );
    assert.equal(
      classifyNpmViewResult(
        1,
        'npm error code E403\nnpm error 404  \'oh-my-codex@0.21.0\' is not in this registry.\n',
      ),
      'error',
    );
    assert.equal(classifyNpmViewResult(1, 'npm error code EAI_AGAIN\nnpm error request to https://registry.npmjs.org failed'), 'error');
    assert.equal(classifyNpmViewResult(1, 'npm error code E401\nnpm error Unable to authenticate'), 'error');
    assert.equal(classifyNpmViewResult(1, 'npm error code ETIMEDOUT'), 'error');
    assert.equal(classifyNpmViewResult(2, 'ENOTFOUND registry.npmjs.org'), 'error');
    assert.equal(classifyNpmViewResult(1, 'HTTP 404 Not Found from a proxy during E401'), 'error');
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

    // No job outside the publish block may reference dispatch inputs.
    const withoutPublishJob = workflow.replace(jobBlock(workflow, PUBLISH_JOB), '');
    const jobsOnly = withoutPublishJob.slice(withoutPublishJob.indexOf('\njobs:'));
    assert.doesNotMatch(jobsOnly, /inputs\.release_tag/);
    assert.doesNotMatch(jobsOnly, /inputs\.release_sha/);
    assert.doesNotMatch(withoutPublishJob, /npm publish/);
  });
});
