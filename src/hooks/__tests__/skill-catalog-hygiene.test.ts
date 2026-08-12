import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { classifyKeywordInput } from '../keyword-detector.js';

const repoRoot = new URL('../../..', import.meta.url).pathname;
const skillsRoot = join(repoRoot, 'skills');

function skillContent(name: string): string {
  return readFileSync(join(skillsRoot, name, 'SKILL.md'), 'utf8');
}

function skillNames(): string[] {
  return readdirSync(skillsRoot)
    .filter((name) => statSync(join(skillsRoot, name)).isDirectory())
    .sort();
}

describe('skill catalog hygiene', () => {
  it('has removed deprecated shims and surfaces sunset stubs', () => {
    const names = skillNames();
    assert.equal(names.length, 29, `expected 29 skills after sunset, got ${names.length}: ${names.join(', ')}`);
    const removed = ['swarm','ask-claude','ask-gemini','frontend-ui-ux','review','ralph-init','ecomode','deepsearch','tdd','build-fix','security-review','visual-verdict','web-clone','help','note','trace','prometheus-strict'];
    for (const name of removed) {
      assert(!names.includes(name), `${name} should have been removed`);
      assert(!existsSync(join(skillsRoot, name)), `${name} directory should not exist`);
      const c = classifyKeywordInput(`$${name} test`);
      assert.equal(c.removedMatches.length, 1, `${name} should have sunset stub`);
      assert.match(c.removedMatches[0].message, /removed/i, `${name} message should contain removed`);
      assert.match(c.removedMatches[0].message, /use/i, `${name} message should contain use`);
    }
  });

  it('keeps the cleanup subset free of obsolete prompt/tool boilerplate', () => {
    const cleanupSubset = ['analyze', 'plan', 'ultraqa'];
    const obsolete = [
      /ToolSearch\(/,
      /mcp__[^\s`]+/,
      /GPT-5\.4 Guidance Alignment/,
      /delegate\(role=/,
    ];

    const offenders = cleanupSubset.flatMap((name) => {
      const content = skillContent(name);
      return obsolete
        .filter((pattern) => pattern.test(content))
        .map((pattern) => `${name}: ${pattern}`);
    });

    assert.deepEqual(offenders, []);
  });

  it('keeps primary workflow guidance CLI-first instead of MCP-first', () => {
    const primaryWorkflows = [
      'code-review',
      'plan',
      'ralph',
      'ultraqa',
      'wiki',
    ];
    const mcpFirstPatterns = [
      /Use `omx_state` MCP tools/i,
      /Use the `omx_state` MCP server tools/i,
      /Before first MCP tool use, call `ToolSearch\("mcp"\)`/i,
      /If ToolSearch finds no MCP tools/i,
      /state_write MCP tool/i,
      /write subsequent updates via omx_state MCP/i,
      /omx state clear --mode/i,
      /omx state state_write/i,
      /state_(?:read|write)\(mode=/i,
      /wiki_(?:ingest|query|lint|add|list|read|delete|refresh)\([^)]*\)/,
    ];

    const offenders = primaryWorkflows.flatMap((name) => {
      const content = skillContent(name);
      return mcpFirstPatterns
        .filter((pattern) => pattern.test(content))
        .map((pattern) => `${name}: ${pattern}`);
    });

    assert.deepEqual(offenders, []);
  });
});
