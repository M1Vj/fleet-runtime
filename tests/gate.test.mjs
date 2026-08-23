import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { runGate, GateError } from "../scripts/lib/gate.mjs";

function fakeFetch(user, scopes = "repo, workflow") {
  return async () => ({
    headers: new Map([["x-oauth-scopes", scopes]]),
    json: async () => user,
  });
}

const goodUser = { login: "M1Vj", type: "User", id: 123456, name: "VJ" };

test("gate passes with matching identity and scopes", async () => {
  const identity = await runGate(
    { FLEET_GH_TOKEN: "t", FLEET_EXPECT_LOGIN: "M1Vj" },
    { killSwitchPath: null, expectedLogin: "M1Vj", token: "t", fetchImpl: fakeFetch(goodUser) },
  );
  assert.equal(identity.login, "M1Vj");
  assert.equal(identity.noreply, "123456+M1Vj@users.noreply.github.com");
});

test("kill switch engaged aborts with code 2", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "fleetgate-"));
  const ks = path.join(dir, "KILL_SWITCH");
  writeFileSync(ks, "halt");
  await assert.rejects(
    runGate({ FLEET_GH_TOKEN: "t" }, { killSwitchPath: ks, expectedLogin: "M1Vj", token: "t", fetchImpl: fakeFetch(goodUser) }),
    (err) => err instanceof GateError && err.code === 2,
  );
});

test("identity mismatch fails closed with code 3", async () => {
  await assert.rejects(
    runGate({ FLEET_GH_TOKEN: "t" }, { killSwitchPath: null, expectedLogin: "M1Vj", token: "t", fetchImpl: fakeFetch({ login: "other", type: "User", id: 2 }) }),
    (err) => err instanceof GateError && err.code === 3,
  );
});

test("bot-type token fails closed with code 3", async () => {
  await assert.rejects(
    runGate({ FLEET_GH_TOKEN: "t" }, { killSwitchPath: null, expectedLogin: "M1Vj", token: "t", fetchImpl: fakeFetch({ login: "M1Vj", type: "Bot", id: 3 }) }),
    (err) => err instanceof GateError && err.code === 3,
  );
});

test("scope mismatch fails closed with code 4", async () => {
  await assert.rejects(
    runGate({ FLEET_GH_TOKEN: "t" }, { killSwitchPath: null, expectedLogin: "M1Vj", token: "t", fetchImpl: fakeFetch(goodUser, "gist") }),
    (err) => err instanceof GateError && err.code === 4,
  );
});

test("missing token fails closed with code 3", async () => {
  await assert.rejects(
    runGate({}, { killSwitchPath: null, expectedLogin: "M1Vj", token: "", fetchImpl: fakeFetch(goodUser) }),
    (err) => err instanceof GateError && err.code === 3,
  );
});
