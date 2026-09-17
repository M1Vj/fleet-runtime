import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

import {
  getDb,
  closeDb,
  recordMistake,
  listMistakes,
  storeRepoMemory,
  getRepoMemory,
  storeFleetKnowledge,
  getFleetMemory,
  recallMemory,
  getSystemPromptMemoryBlock,
  parseMemoryMarkdown,
  formatMemoryMarkdown,
  getRepoSlug,
} from "../scripts/lib/persistent-memory.mjs";
import { handleToolCall } from "../scripts/lib/memory-mcp-server.mjs";

test("persistent memory: SQLite in-memory initialization and mistake recording", () => {
  closeDb();
  const testEnv = { FLEET_MEMORY_DB: ":memory:" };
  const db = getDb(testEnv);
  assert.ok(db, "DB should be initialized");

  const recorded = recordMistake({
    errorSignature: "PUT /repos/... failed: email wasn't supplied",
    mistakeDescription: "Dropped undefined email field in JSON payload",
    correctFix: "Use identity.noreply || identity.email in author and committer",
    repo: "fleet-runtime",
    tags: ["github-api", "attribution"],
  }, testEnv);
  assert.equal(recorded, true);

  // Record again to test occurrence increment
  recordMistake({
    errorSignature: "PUT /repos/... failed: email wasn't supplied",
    mistakeDescription: "Dropped undefined email field in JSON payload",
    correctFix: "Use identity.noreply || identity.email in author and committer",
    repo: "fleet-runtime",
    tags: ["github-api", "attribution", "v2"],
  }, testEnv);

  const mistakes = listMistakes({ repo: "fleet-runtime" }, testEnv);
  assert.equal(mistakes.length, 1);
  assert.equal(mistakes[0].occurrences, 2);
  assert.match(mistakes[0].correctFix, /identity\.noreply/);
  assert.ok(mistakes[0].tags.includes("v2"));

  closeDb();
});

test("persistent memory: repo memory storage and bidirectional MEMORY.md sync", () => {
  closeDb();
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-mem-test-"));
  const testEnv = {
    FLEET_MEMORY_DB: path.join(tempDir, "state", "test.db"),
    FLEET_STATE_ROOT: tempDir,
  };

  storeRepoMemory(tempDir, {
    techStack: ["Node.js 20", "Next.js 16.3"],
    conventions: ["Zero Gemini models", "Universal commit author Vj"],
    testCommands: ["npm test", "npm run lint"],
    recentLearnings: ["Contents API requires author.email"],
  }, { syncFile: true }, testEnv);

  const memory = getRepoMemory(tempDir, testEnv);
  assert.ok(memory.techStack.includes("Next.js 16.3"));
  assert.ok(memory.conventions.includes("Zero Gemini models"));
  assert.ok(memory.testCommands.includes("npm test"));

  // Check that MEMORY.md was created and has formatted content
  const memoryMdPath = path.join(tempDir, "MEMORY.md");
  assert.ok(fs.existsSync(memoryMdPath));
  const mdContent = fs.readFileSync(memoryMdPath, "utf8");
  assert.match(mdContent, /Next\.js 16\.3/);
  assert.match(mdContent, /Zero Gemini models/);

  // Test parseMemoryMarkdown
  const parsed = parseMemoryMarkdown(mdContent);
  assert.ok(parsed.techStack.includes("Next.js 16.3"));
  assert.ok(parsed.conventions.includes("Zero Gemini models"));

  closeDb();
  try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch {}
});

test("persistent memory: system prompt block generation", () => {
  closeDb();
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-mem-prompt-test-"));
  const testEnv = { FLEET_MEMORY_DB: ":memory:" };

  recordMistake({
    errorSignature: "HTTP 429 Too Many Requests",
    mistakeDescription: "Direct datacenter IP quota exhausted",
    correctFix: "Route via indefinite proxy dispatcher on port 58444",
    repo: "global",
    tags: ["quota", "proxy"],
  }, testEnv);

  storeRepoMemory(tempDir, {
    testCommands: ["rtk test node --test tests/*.test.mjs"],
    conventions: ["Always prefix shell commands with rtk"],
  }, {}, testEnv);

  const block = getSystemPromptMemoryBlock(tempDir, testEnv);
  assert.match(block, /<persistent_cross_session_memory>/);
  assert.match(block, /HTTP 429 Too Many Requests/);
  assert.match(block, /Route via indefinite proxy dispatcher/);
  assert.match(block, /rtk test node --test/);
  assert.match(block, /<\/persistent_cross_session_memory>/);

  closeDb();
  try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch {}
});

test("memory MCP server: tool call routing", () => {
  closeDb();
  const testEnv = { FLEET_MEMORY_DB: ":memory:" };

  const storeRes = handleToolCall("memory_store", {
    category: "convention",
    value: "Zero Gemini models invariant",
  }, testEnv);
  assert.match(storeRes.content[0].text, /Memory stored successfully/);

  const mistakeRes = handleToolCall("memory_record_mistake", {
    errorSignature: "HTTP 422 email wasn't supplied",
    mistakeDescription: "Contents API requires email field",
    correctFix: "Supply identity.noreply in author and committer",
  }, testEnv);
  assert.match(mistakeRes.content[0].text, /Mistake recorded successfully/);

  const listRes = handleToolCall("memory_list_mistakes", {}, testEnv);
  const parsedMistakes = JSON.parse(listRes.content[0].text);
  assert.equal(parsedMistakes.length, 1);
  assert.match(parsedMistakes[0].errorSignature, /email wasn't supplied/);

  closeDb();
});
