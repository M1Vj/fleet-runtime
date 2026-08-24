import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const source = readFileSync(new URL("../scripts/improve.mjs", import.meta.url), "utf8");
const finalize = source.slice(source.indexOf("async function modeFinalize"), source.indexOf("const MODES"));

test("improve finalize persists private review findings without public comments", () => {
  assert.doesNotMatch(finalize, /issues\/\$\{.*comments|verifyCommentAuthor|commentsPosted/);
  assert.match(finalize, /findings/);
  assert.match(finalize, /runRecord/);
});
