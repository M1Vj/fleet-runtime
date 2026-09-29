import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const dispatcherPath = path.resolve("scripts/lib/indefinite-dispatcher.mjs");
const modelPath = path.resolve("scripts/lib/model.mjs");

test("embedded dispatcher default port avoids 58444 and 58445", () => {
  const dispatcherSrc = fs.readFileSync(dispatcherPath, "utf8");
  const modelSrc = fs.readFileSync(modelPath, "utf8");

  const defaultPortMatch = dispatcherSrc.match(/const DEFAULT_PORT\s*=\s*(\d+);/);
  assert.ok(defaultPortMatch, "dispatcher must declare a numeric DEFAULT_PORT");
  const defaultPort = Number(defaultPortMatch[1]);
  assert.notEqual(defaultPort, 58444, "default must not collide with the live indefinite dispatcher");
  assert.notEqual(defaultPort, 58445, "default must not collide with the sibling lane dispatcher");
  assert.equal(defaultPort, 58446, "runtime embedded dispatcher default is 58446");

  assert.match(
    modelSrc,
    /env\.FLEET_DISPATCHER_PORT\s*\|\|\s*58446/,
    "model.mjs must fall back to 58446",
  );
  assert.doesNotMatch(modelSrc, /FLEET_DISPATCHER_PORT\s*\|\|\s*58444/);

  assert.match(dispatcherSrc, /FLEET_DISPATCHER_PORT/, "dispatcher must keep the env override");
  assert.match(modelSrc, /FLEET_DISPATCHER_PORT/, "model.mjs must keep the env override");
});

import { isAllowedConnectTarget, parseConnectTarget } from "../scripts/lib/indefinite-dispatcher.mjs";

test("embedded dispatcher CONNECT relay is scoped to opencode.ai:443", () => {
  const src = fs.readFileSync(dispatcherPath, "utf8");
  assert.match(src, /parseConnectTarget/, "scoped CONNECT target parser must be present");
  assert.match(src, /CONNECT_RELAY_TARGET/, "relay must dial the pinned relay target");
  assert.match(src, /405 Method Not Allowed/, "non-allowlisted CONNECT targets must be refused with 405");
  assert.match(src, /200 Connection Established/, "allowlisted CONNECT target must establish the relay");
  assert.match(
    src,
    /opencode\.ai/,
    "opencode.ai forwarding targets must remain",
  );
  assert.match(src, /sendDirect/, "direct HTTPS forwarding path must remain");
  assert.doesNotMatch(src, /method:\s*["']CONNECT["']/, "no upstream CONNECT-via-proxy chaining may exist");

  assert.deepEqual(parseConnectTarget("opencode.ai:443"), { host: "opencode.ai", port: 443, allowed: true });
  assert.equal(isAllowedConnectTarget("OPENCODE.AI:443"), true);
  for (const refused of ["evil.com:443", "169.254.169.254:80", "opencode.ai:80", "user@opencode.ai:443"]) {
    assert.equal(isAllowedConnectTarget(refused), false, `${refused} must be refused`);
  }
});
