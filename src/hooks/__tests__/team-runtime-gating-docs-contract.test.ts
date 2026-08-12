import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, '../../../');

function read(path: string): string {
  return readFileSync(join(repoRoot, path), 'utf-8');
}

describe('team runtime gating docs contract', () => {
  it('keeps operator-facing team surfaces explicit about outside-tmux/Codex App gating', () => {
    const surfaces = [
      'README.md',
      'skills/team/SKILL.md',
      'src/cli/team.ts',
      'templates/AGENTS.md',
      'AGENTS.md',
    ].filter((path) => existsSync(join(repoRoot, path)));

    for (const surface of surfaces) {
      const content = read(surface);
      assert.match(content, /Codex App|outside-tmux|outside tmux/i, `${surface} must mention app/outside-tmux context`);
      assert.match(content, /tmux-runtime|tmux runtime|runtime boundary|CLI runtime/i, `${surface} must describe the tmux/CLI runtime boundary`);
      assert.match(content, /runtime boundary|tmux-runtime|launch OMX CLI from shell first|not directly available/i, `${surface} must explain the app-safe fallback`);
    }
  });
});
