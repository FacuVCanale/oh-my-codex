import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { KEYWORD_TRIGGER_DEFINITIONS } from '../keyword-registry.js';
import { REMOVED_SKILLS } from '../sunset-stub.js';

// dist/hooks/__tests__/ -> repo root
const repoRoot = join(fileURLToPath(import.meta.url), '..', '..', '..', '..');

interface CatalogSkill {
  name: string;
  status: string;
}

function catalogSkills(): CatalogSkill[] {
  const manifest = JSON.parse(
    readFileSync(join(repoRoot, 'src', 'catalog', 'manifest.json'), 'utf-8'),
  ) as { skills: CatalogSkill[] };
  return manifest.skills;
}

/** Names a user can invoke and reach a real surface: active, internal, or an alias/merge target. */
function invocableSkillNames(): Set<string> {
  return new Set(
    catalogSkills()
      .filter((skill) => ['active', 'internal', 'alias', 'merged'].includes(skill.status))
      .map((skill) => skill.name),
  );
}

/** Documentation lines may name a retired skill only when the same line says so. */
const REMOVAL_LABELS = [
  'Removed in OMX 0.21',
  'was removed in OMX 0.21',
  'OMX 0.21 移除',
  'OMX 0.21 降級',
  'sunset stub',
  'has been removed',
];

const DOC_SURFACES = [
  join('docs', 'skills.html'),
  join('docs', 'readme', 'README.zh-TW.md'),
  join('docs', 'prompt-guidance-contract.md'),
];

describe('sunset routing contract', () => {
  it('drops the over-broad parallel trigger', () => {
    const parallel = KEYWORD_TRIGGER_DEFINITIONS.filter((entry) => entry.keyword === 'parallel');
    assert.deepEqual(
      parallel,
      [],
      'a bare English word must not activate a workflow; `parallel` routed to the ultrawork sunset stub',
    );
  });

  it('resolves every sunset replacement directly to an invocable skill', () => {
    const invocable = invocableSkillNames();
    const deadEnds: string[] = [];

    for (const [removed, info] of Object.entries(REMOVED_SKILLS)) {
      if (info.replacement === null) continue;
      const target = info.replacement.replace(/^\$/, '');
      if (!invocable.has(target)) {
        deadEnds.push(`$${removed} -> ${info.replacement} (${target} is not invocable)`);
      }
    }

    assert.deepEqual(
      deadEnds,
      [],
      'a replacement that points at another retired skill is a two-hop dead end: '
      + `${deadEnds.join(', ')}`,
    );
  });

  it('keeps every removed-skill message actionable', () => {
    for (const [removed, info] of Object.entries(REMOVED_SKILLS)) {
      assert.match(info.message, /removed/i, `${removed} message must say it was removed`);
      if (info.replacement !== null) {
        assert.ok(
          info.message.includes(info.replacement),
          `${removed} message must name its replacement ${info.replacement}`,
        );
      }
    }
  });

  it('never routes a keyword trigger at a skill the catalog does not ship', () => {
    const shipped = new Set(catalogSkills().map((skill) => skill.name));
    const unknown = KEYWORD_TRIGGER_DEFINITIONS
      .filter((entry) => !shipped.has(entry.skill))
      .map((entry) => `${entry.keyword} -> ${entry.skill}`);

    assert.deepEqual(
      unknown,
      [],
      `these triggers activate a skill absent from the catalog manifest: ${unknown.join(', ')}`,
    );
  });

  it('advertises no retired skill token in documentation without labelling it', () => {
    const invocable = invocableSkillNames();
    const violations: string[] = [];

    for (const relPath of DOC_SURFACES) {
      const content = readFileSync(join(repoRoot, relPath), 'utf-8');
      content.split('\n').forEach((line, index) => {
        const labelled = REMOVAL_LABELS.some((label) => line.includes(label));
        if (labelled) return;
        for (const match of line.matchAll(/\$([a-z][a-z0-9-]*)/g)) {
          const token = match[1];
          // `$name` is a prose placeholder, not a skill invocation.
          if (token === 'name') continue;
          if (!invocable.has(token)) {
            violations.push(`${relPath}:${index + 1} $${token}`);
          }
        }
      });
    }

    assert.deepEqual(
      violations,
      [],
      'documentation must not advertise a retired skill without a removal label: '
      + `${violations.join(', ')}`,
    );
  });

  it('keeps the ralplan skill mirrors byte-identical', () => {
    const root = readFileSync(join(repoRoot, 'skills', 'ralplan', 'SKILL.md'), 'utf-8');
    const mirror = readFileSync(
      join(repoRoot, 'plugins', 'oh-my-codex', 'skills', 'ralplan', 'SKILL.md'),
      'utf-8',
    );
    assert.equal(mirror, root, 'the plugin mirror must match the canonical ralplan skill exactly');
  });

  it('does not cite a deleted prompt or role as available', () => {
    for (const relPath of [
      join('skills', 'ralplan', 'SKILL.md'),
      join('plugins', 'oh-my-codex', 'skills', 'ralplan', 'SKILL.md'),
    ]) {
      const content = readFileSync(join(repoRoot, relPath), 'utf-8');
      assert.doesNotMatch(
        content,
        /Scholastic/,
        `${relPath} must not cite the Scholastic role; prompts/scholastic.md was deleted in OMX 0.21`,
      );
    }
    const contract = readFileSync(join(repoRoot, 'docs', 'prompt-guidance-contract.md'), 'utf-8');
    assert.doesNotMatch(
      contract,
      /`prompts\/sisyphus-lite\.md` should be treated/,
      'the contract must not tell overlays to compose the deleted sisyphus-lite prompt',
    );
  });
});
