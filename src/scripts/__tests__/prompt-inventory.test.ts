import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import {
  buildPromptInventory,
  checkPromptInvariantDuplicates,
  listPromptSurfacePaths,
  renderPromptInventoryMarkdown,
  runPromptInventoryCli,
} from '../prompt-inventory.js';

describe('prompt inventory', () => {
  it('counts prompt surfaces, absolute directives, markers, and duplicate fragments', async () => {
    const root = await mkdtemp(join(tmpdir(), 'omx-prompt-inventory-'));
    try {
      await mkdir(join(root, 'templates'), { recursive: true });
      await mkdir(join(root, 'prompts'), { recursive: true });
      await mkdir(join(root, 'skills', 'worker'), { recursive: true });
      await mkdir(join(root, 'docs', 'prompt-guidance-fragments'), { recursive: true });
      await mkdir(join(root, 'src', 'hooks'), { recursive: true });
      await mkdir(join(root, 'src', 'config'), { recursive: true });
      await mkdir(join(root, 'src', 'cli'), { recursive: true });

      const repeated = 'AUTO-CONTINUE for clear, already-requested, low-risk, reversible local work with evidence.';
      await writeFile(join(root, 'AGENTS.md'), `# Root\n${repeated}\n<!-- omx:generated:agents-md -->\n`);
      await writeFile(
        join(root, 'templates', 'AGENTS.md'),
        `# Template\nMUST preserve markers.\n${repeated}\n<!-- OMX:RUNTIME:START -->\n<!-- OMX:RUNTIME:END -->\n`,
      );
      await writeFile(join(root, 'prompts', 'executor.md'), `# Executor\nDO NOT stop early.\n${repeated}\n`);
      await writeFile(join(root, 'skills', 'worker', 'SKILL.md'), '# Worker\nALWAYS claim tasks.\n');
      await writeFile(join(root, 'docs', 'prompt-guidance-contract.md'), '# Contract\n');
      await writeFile(join(root, 'docs', 'guidance-schema.md'), '# Schema\n');
      await writeFile(join(root, 'docs', 'prompt-guidance-fragments', 'core.md'), 'fragment\n');
      await writeFile(join(root, 'src', 'hooks', 'prompt-guidance-contract.ts'), 'export {};\n');
      await writeFile(join(root, 'src', 'config', 'generator.ts'), 'export {};\n');
      await writeFile(join(root, 'src', 'cli', 'setup.ts'), 'export {};\n');

      const paths = listPromptSurfacePaths(root);
      assert.deepEqual(paths, [
        'AGENTS.md',
        'docs/guidance-schema.md',
        'docs/prompt-guidance-contract.md',
        'docs/prompt-guidance-fragments/core.md',
        'prompts/executor.md',
        'skills/worker/SKILL.md',
        'src/cli/setup.ts',
        'src/config/generator.ts',
        'src/hooks/prompt-guidance-contract.ts',
        'templates/AGENTS.md',
      ]);

      const report = buildPromptInventory(root, '2026-01-01T00:00:00.000Z');
      assert.equal(report.totals.files, paths.length);
      assert.ok(report.totals.lines > 0);
      assert.ok(report.totals.approximateTokens > 0);
      assert.equal(report.totals.absoluteDirectiveCount, 6);
      assert.equal(
        report.surfaces.find((surface) => surface.path === 'templates/AGENTS.md')?.markers['<!-- OMX:RUNTIME:START -->'],
        1,
      );
      assert.equal(report.duplicateFragmentFamilies[0]?.count, 3);
      assert.match(renderPromptInventoryMarkdown(report), /# Prompt Inventory/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('checks only explicit durable invariant phrases and reports skill duplicates', async () => {
    const root = await mkdtemp(join(tmpdir(), 'omx-prompt-invariant-check-'));
    const statePhrase = 'compatibility discovery is read-only';
    try {
      await mkdir(join(root, 'skills', 'one'), { recursive: true });
      await mkdir(join(root, 'skills', 'two'), { recursive: true });
      await mkdir(join(root, 'skills', 'generic'), { recursive: true });
      await mkdir(join(root, 'templates'), { recursive: true });
      await writeFile(join(root, 'templates', 'AGENTS.md'), `# SSOT\n${statePhrase}\n`);
      await writeFile(join(root, 'skills', 'one', 'SKILL.md'), `---\nname: one\n---\n${statePhrase}\n`);
      await writeFile(join(root, 'skills', 'two', 'SKILL.md'), `---\nname: two\n---\n${statePhrase}\n`);
      await writeFile(join(root, 'skills', 'generic', 'SKILL.md'), 'This skill discusses state and team behavior without durable invariant wording.\n');

      const report = checkPromptInvariantDuplicates(root);
      assert.equal(report.ok, false);
      assert.deepEqual(report.checkedPaths, [
        'skills/generic/SKILL.md',
        'skills/one/SKILL.md',
        'skills/two/SKILL.md',
      ]);
      assert.deepEqual(report.duplicates, [{
        ruleId: 'state-ownership',
        phrase: statePhrase,
        paths: ['skills/one/SKILL.md', 'skills/two/SKILL.md'],
      }]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('passes clean checks, ignores the authorized SSOT, and returns actionable CLI status', async () => {
    const root = await mkdtemp(join(tmpdir(), 'omx-prompt-invariant-clean-'));
    const output: string[] = [];
    const originalLog = console.log;
    try {
      await mkdir(join(root, 'skills', 'one'), { recursive: true });
      await mkdir(join(root, 'skills', 'two'), { recursive: true });
      await mkdir(join(root, 'templates'), { recursive: true });
      await writeFile(join(root, 'templates', 'AGENTS.md'), 'Hooks own normal skill activation\n');
      await writeFile(join(root, 'skills', 'one', 'SKILL.md'), 'This skill says state must remain scoped.\n');
      await writeFile(join(root, 'skills', 'two', 'SKILL.md'), 'This skill says state must remain scoped too.\n');
      console.log = (...args: unknown[]) => output.push(args.join(' '));

      const report = checkPromptInvariantDuplicates(root);
      assert.equal(report.ok, true);
      assert.deepEqual(report.duplicates, []);
      assert.equal(runPromptInventoryCli(['--check', '--root', root], root), 0);
      assert.match(output.join('\n'), /prompt invariant check ok/);
      assert.equal(runPromptInventoryCli(['--check', '--root'], root), 1);
    } finally {
      console.log = originalLog;
      await rm(root, { recursive: true, force: true });
    }
  });
});
