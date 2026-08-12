#!/usr/bin/env node
import { existsSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';

async function read(path: string): Promise<string> { return await readFile(path, 'utf-8'); }

function replaceBetween(text: string, startMarker: string, endMarker: string, replacement: string): string {
  const start = text.indexOf(startMarker);
  const end = text.indexOf(endMarker, start + startMarker.length);
  if (start === -1 || end === -1) throw new Error(`Markers not found: ${startMarker} .. ${endMarker}`);
  return text.slice(0, start + startMarker.length) + '\n' + replacement.trimEnd() + '\n' + text.slice(end);
}

async function main(): Promise<void> {
  const check = process.argv.includes('--check');
  const op = (await read('docs/prompt-guidance-fragments/core-operating-principles.md')).trim();
  const sr = (await read('docs/prompt-guidance-fragments/leader-specialist-routing.md')).trim();
  const vs = (await read('docs/prompt-guidance-fragments/core-verification-and-sequencing.md')).trim();
  const exC = (await read('docs/prompt-guidance-fragments/executor-constraints.md')).trim();
  const exO = (await read('docs/prompt-guidance-fragments/executor-output.md')).trim();
  const plC = (await read('docs/prompt-guidance-fragments/planner-constraints.md')).trim();
  const plI = (await read('docs/prompt-guidance-fragments/planner-investigation.md')).trim();
  const plO = (await read('docs/prompt-guidance-fragments/planner-output.md')).trim();
  const vfC = (await read('docs/prompt-guidance-fragments/verifier-constraints.md')).trim();
  const vfI = (await read('docs/prompt-guidance-fragments/verifier-investigation.md')).trim();

  const targets: Array<{ file: string; replacements: Array<[string, string, string]> }> = [
    {
      file: 'AGENTS.md',
      replacements: [
        ['<!-- OMX:GUIDANCE:OPERATING:START -->', '<!-- OMX:GUIDANCE:OPERATING:END -->', op],
        ['<!-- OMX:GUIDANCE:SPECIALIST-ROUTING:START -->', '<!-- OMX:GUIDANCE:SPECIALIST-ROUTING:END -->', sr],
        ['<!-- OMX:GUIDANCE:VERIFYSEQ:START -->', '<!-- OMX:GUIDANCE:VERIFYSEQ:END -->', vs],
      ],
    },
    {
      file: 'templates/AGENTS.md',
      replacements: [
        ['<!-- OMX:GUIDANCE:OPERATING:START -->', '<!-- OMX:GUIDANCE:OPERATING:END -->', op],
        ['<!-- OMX:GUIDANCE:SPECIALIST-ROUTING:START -->', '<!-- OMX:GUIDANCE:SPECIALIST-ROUTING:END -->', sr],
        ['<!-- OMX:GUIDANCE:VERIFYSEQ:START -->', '<!-- OMX:GUIDANCE:VERIFYSEQ:END -->', vs],
      ],
    },
    {
      file: 'prompts/executor.md',
      replacements: [
        ['<!-- OMX:GUIDANCE:EXECUTOR:CONSTRAINTS:START -->', '<!-- OMX:GUIDANCE:EXECUTOR:CONSTRAINTS:END -->', exC],
        ['<!-- OMX:GUIDANCE:EXECUTOR:OUTPUT:START -->', '<!-- OMX:GUIDANCE:EXECUTOR:OUTPUT:END -->', exO],
      ],
    },
    {
      file: 'prompts/planner.md',
      replacements: [
        ['<!-- OMX:GUIDANCE:PLANNER:CONSTRAINTS:START -->', '<!-- OMX:GUIDANCE:PLANNER:CONSTRAINTS:END -->', plC],
        ['<!-- OMX:GUIDANCE:PLANNER:INVESTIGATION:START -->', '<!-- OMX:GUIDANCE:PLANNER:INVESTIGATION:END -->', plI],
        ['<!-- OMX:GUIDANCE:PLANNER:OUTPUT:START -->', '<!-- OMX:GUIDANCE:PLANNER:OUTPUT:END -->', plO],
      ],
    },
    {
      file: 'prompts/verifier.md',
      replacements: [
        ['<!-- OMX:GUIDANCE:VERIFIER:CONSTRAINTS:START -->', '<!-- OMX:GUIDANCE:VERIFIER:CONSTRAINTS:END -->', vfC],
        ['<!-- OMX:GUIDANCE:VERIFIER:INVESTIGATION:START -->', '<!-- OMX:GUIDANCE:VERIFIER:INVESTIGATION:END -->', vfI],
      ],
    },
  ];

  const drift: string[] = [];
  for (const target of targets) {
    if (!existsSync(target.file)) continue;
    let text = await read(target.file);
    let expected = text;
    for (const [start, end, replacement] of target.replacements) {
      expected = replaceBetween(expected, start, end, replacement);
    }
    if (check) {
      if (expected !== text) drift.push(target.file);
    } else {
      if (expected !== text) await writeFile(target.file, expected);
    }
  }

  if (check && drift.length > 0) {
    throw new Error(`prompt_guidance_fragment_drift:${drift.join(',')}`);
  }
  if (check) console.log('prompt guidance check ok');
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
