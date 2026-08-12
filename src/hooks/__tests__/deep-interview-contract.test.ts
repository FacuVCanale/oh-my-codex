import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

const deepInterviewSkill = readFileSync(join(__dirname, "../../../skills/deep-interview/SKILL.md"), "utf-8");
const planSkill = readFileSync(join(__dirname, "../../../skills/plan/SKILL.md"), "utf-8");
const ralplanSkill = readFileSync(join(__dirname, "../../../skills/ralplan/SKILL.md"), "utf-8");

describe("deep-interview sunset stub (merged into plan --interview)", () => {
  it("is a sunset stub pointing to plan --interview", () => {
    assert.match(deepInterviewSkill, /was removed/i);
    assert.match(deepInterviewSkill, /\$plan --interview/i);
  });

  it("is mirrored as a deprecated skill in catalog", () => {
    assert.match(deepInterviewSkill, /Sunset stub/i);
  });

  it("ralplan is also a sunset stub pointing to plan", () => {
    assert.match(ralplanSkill, /was removed/i);
    assert.match(ralplanSkill, /\$plan/i);
  });

  it("plan now owns interview mode", () => {
    assert.match(planSkill, /--interview/i);
    assert.match(planSkill, /Interview/i);
    assert.match(planSkill, /omx question/i);
  });

  it("plan interview mentions Socratic questioning", () => {
    assert.match(planSkill, /Socratic/i);
  });

  it("plan remains slim and does not contain consensus ceremony", () => {
    assert.doesNotMatch(planSkill, /consensus/i);
    assert.doesNotMatch(planSkill, /RALPLAN-DR/i);
    assert.doesNotMatch(planSkill, /documented_host_consensus/i);
    assert.ok(planSkill.split("\n").length <= 120, "plan should be ≤120 lines");
  });
});
