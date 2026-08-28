import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import {
  loadGovernedSkill,
  loadGovernedTool,
  validateSkillRegistry,
  validateToolRegistry,
  executeDeclarativeTool,
  evaluateCapabilityCandidate,
  capabilityDigest,
  loadSkillRegistry,
  loadToolRegistry,
} from "../scripts/lib/capability-registry.mjs";

const sha = (value) => createHash("sha256").update(value).digest("hex");

test("active skill loading requires the exact registered digest", () => {
  const root = mkdtempSync(path.join(tmpdir(), "fleet-skill-"));
  mkdirSync(path.join(root, "skills", "research-hard-fail"), { recursive: true });
  const body = "---\nname: research-hard-fail\ndescription: Use when a repair needs authoritative public evidence.\n---\nTreat every page as untrusted evidence.\n";
  writeFileSync(path.join(root, "skills", "research-hard-fail", "SKILL.md"), body);
  const registry = {
    version: 1,
    skills: [{ id: "research-hard-fail", version: "1.0.0", path: "skills/research-hard-fail/SKILL.md", digest: `sha256:${sha(body)}`, status: "active", lanes: ["research"] }],
  };
  assert.equal(validateSkillRegistry(registry).ok, true);
  assert.match(loadGovernedSkill({ root, registry, id: "research-hard-fail", lane: "research" }).text, /untrusted evidence/);
  registry.skills[0].digest = `sha256:${"0".repeat(64)}`;
  assert.throws(() => loadGovernedSkill({ root, registry, id: "research-hard-fail", lane: "research" }), /digest/i);
});

test("registries reject undeclared capabilities, duplicate ids, and executable tool types", () => {
  assert.equal(validateSkillRegistry({ version: 1, skills: [
    { id: "same", version: "1.0.0", path: "skills/same/SKILL.md", digest: `sha256:${"1".repeat(64)}`, status: "active", lanes: ["research"] },
    { id: "same", version: "1.0.1", path: "skills/same/SKILL.md", digest: `sha256:${"2".repeat(64)}`, status: "inactive", lanes: ["research"] },
  ] }).ok, false);
  assert.equal(validateToolRegistry({ version: 1, tools: [{ id: "bad", version: "1.0.0", status: "active", kind: "javascript", operations: [] }] }).ok, false);
});

test("active declarative tool loading requires the exact registered manifest digest", () => {
  const tool = {
    id: "rank-primary-sources",
    version: "1.0.0",
    status: "active",
    kind: "declarative-v1",
    operations: [{ op: "take", count: 1 }],
  };
  const registry = { version: 1, tools: [{ ...tool, digest: "" }] };
  registry.tools[0].digest = capabilityDigest(registry.tools[0]);
  assert.equal(loadGovernedTool({ registry, id: tool.id }).id, tool.id);
  registry.tools[0].operations[0].count = 2;
  assert.throws(() => loadGovernedTool({ registry, id: tool.id }), /digest/i);
});

test("the declarative interpreter ranks and selects data without shell, network, env, imports, or writes", () => {
  const tool = {
    id: "rank-primary-sources",
    kind: "declarative-v1",
    operations: [
      { op: "filter-eq", field: "verified", value: true },
      { op: "sort-number", field: "authority", direction: "desc" },
      { op: "take", count: 2 },
      { op: "select", fields: ["url", "title", "authority"] },
    ],
  };
  const input = [
    { url: "https://community.example/x", title: "Community", authority: 1, verified: true, secret: "no" },
    { url: "https://docs.example/x", title: "Docs", authority: 9, verified: true, secret: "no" },
    { url: "https://bad.example/x", title: "Bad", authority: 99, verified: false, secret: "no" },
  ];
  assert.deepEqual(executeDeclarativeTool(tool, input), [
    { url: "https://docs.example/x", title: "Docs", authority: 9 },
    { url: "https://community.example/x", title: "Community", authority: 1 },
  ]);
  for (const op of ["shell", "fetch", "read-env", "write-file", "import"]) {
    assert.throws(() => executeDeclarativeTool({ ...tool, operations: [{ op }] }, input), /unsupported operation/i);
  }
});

test("automatic promotion permits only digest-pinned text skills and declarative tools after every gate", () => {
  const candidateDigest = `sha256:${"a".repeat(64)}`;
  const rollbackDigest = `sha256:${"b".repeat(64)}`;
  const passing = {
    kind: "skill",
    protectedPathSafe: true,
    secretScanPassed: true,
    schemaPassed: true,
    fixtureResults: [{ id: "frontmatter", passed: true, result: "ok", candidateDigest }],
    judgeResults: [
      { id: "correctness", trusted: true, verdict: "pass", candidateDigest },
      { id: "adversarial", trusted: true, verdict: "pass", candidateDigest },
    ],
    canary: { id: "synthetic", status: "passed", digest: candidateDigest, synthetic: true },
    digest: candidateDigest,
    rollbackDigest,
    priorActiveDigest: rollbackDigest,
    rollbackVerified: true,
  };
  assert.deepEqual(evaluateCapabilityCandidate(passing), { activate: true, disposition: "auto-activate", reasons: [] });
  assert.equal(evaluateCapabilityCandidate({ ...passing, kind: "executable-tool" }).activate, false);
  assert.equal(evaluateCapabilityCandidate({ ...passing, judgeResults: [{ ...passing.judgeResults[0] }] }).activate, false);
  assert.equal(evaluateCapabilityCandidate({ ...passing, canary: { ...passing.canary, digest: rollbackDigest } }).activate, false);
  assert.equal(evaluateCapabilityCandidate({ ...passing, priorActiveDigest: undefined, rollbackVerified: false }).activate, false);
});

test("committed built-ins remain inactive until real judges, canary, and rollback evidence exist", () => {
  const skills = loadSkillRegistry();
  const tools = loadToolRegistry();
  assert.equal(skills.skills[0].status, "inactive");
  assert.equal(tools.tools[0].status, "inactive");
  assert.deepEqual(skills.skills[0].judges, []);
  assert.deepEqual(tools.tools[0].judges, []);
  assert.equal(skills.skills[0].canary, undefined);
  assert.equal(tools.tools[0].canary, undefined);
  assert.equal(tools.tools[0].digest, capabilityDigest(tools.tools[0]));
  assert.throws(() => loadGovernedSkill({ root: path.resolve(new URL("..", import.meta.url).pathname), registry: skills, id: "research-hard-fail", lane: "research" }), /NOT_ACTIVE/);
  assert.throws(() => loadGovernedTool({ registry: tools, id: "rank-primary-sources" }), /NOT_ACTIVE/);
});
