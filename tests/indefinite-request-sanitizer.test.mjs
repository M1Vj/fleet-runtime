import test from "node:test";
import assert from "node:assert/strict";
import {
  ensureValidJsonString,
  sanitizeRequestBody,
} from "../scripts/lib/request-sanitizer.mjs";

test("request sanitizer: JSON string validation and schema repair", () => {
  assert.deepEqual(ensureValidJsonString('{"key":"value"}'), { valid: true, value: '{"key":"value"}' });
  const raw = ensureValidJsonString("plain text non-json");
  assert.equal(raw.valid, false);
  assert.deepEqual(JSON.parse(raw.value), { raw_unparsed: "plain text non-json" });
});

test("request sanitizer: rewrites union-alpha variants to muse-spark-1.3-contributor-free", () => {
  for (const m of ["union-alpha", "opencode/union-alpha", "union", "alpha"]) {
    const payload = Buffer.from(JSON.stringify({ model: m, input: [{ type: "message", content: "hello" }] }));
    const sanitized = sanitizeRequestBody(payload, "test-union-rewrite");
    const parsed = JSON.parse(sanitized.toString("utf8"));
    assert.equal(parsed.model, "opencode/muse-spark-1.3-contributor-free");
  }
});

test("request sanitizer: enforces capabilities and reasoning.effort xhigh", () => {
  const payload = {
    model: "opencode/muse-spark-1.3-contributor-free",
    input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "query" }] }],
  };
  const sanitized = sanitizeRequestBody(
    Buffer.from(JSON.stringify(payload)),
    "test-caps",
    { enforceCapabilities: true },
  );
  const parsed = JSON.parse(sanitized.toString("utf8"));
  assert.equal(parsed.max_output_tokens, 16384);
  assert.equal(parsed.reasoning?.effort, "xhigh");
});

test("request sanitizer: strips historical reasoning and encrypted content on forceFullStrip", () => {
  const payload = {
    model: "opencode/muse-spark-1.3-contributor-free",
    input: [
      { type: "reasoning", content: "private thoughts" },
      { type: "message", role: "user", content: "hi", encrypted_content: "secret-abc" },
    ],
  };
  const cleaned = sanitizeRequestBody(
    Buffer.from(JSON.stringify(payload)),
    "test-strip",
    { forceFullStrip: true },
  );
  const parsed = JSON.parse(cleaned.toString("utf8"));
  assert.equal(parsed.input.length, 1);
  assert.equal(parsed.input[0].type, "message");
  assert.equal(parsed.input[0].encrypted_content, undefined);
});
