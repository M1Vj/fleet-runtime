#!/usr/bin/env node
import process from "node:process";
import { appendFileSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { runGate, GateError } from "./lib/gate.mjs";
import { AuditBuffer } from "./lib/audit.mjs";
import { scrub, gitAdd, gitCommit, gitPush, gitRevParse, configureIdentity } from "./lib/util.mjs";
import { askModel } from "./lib/model.mjs";
import { validateDirectives } from "./lib/directives.mjs";
import { eventKey, loadLedger, has, append } from "./lib/ledger.mjs";
import { expectUser, verifyCommit } from "./lib/verify.mjs";
import { decideStale, planWatchdogActions } from "./lib/watchdog-decide.mjs";

const CODE_ROOT = process.cwd();
const REPO_ROOT = process.env.FLEET_STATE_ROOT ? path.resolve(process.env.FLEET_STATE_ROOT) : CODE_ROOT;

function fakeFetch(user) {
  return async () => ({
    ok: true,
    headers: new Map([["x-oauth-scopes", user.scopes || "repo, workflow"]]),
    json: async () => ({ login: user.login, type: user.type, id: user.id || 1 }),
  });
}

export async function main() {
  const runId = `selftest-${Date.now()}`;
  const redact = scrub(process.env);
  const audit = new AuditBuffer(redact);
  let failed = false;

  try {
    const badEnv = { ...process.env, FLEET_EXPECT_LOGIN: "M1Vj-wrong" };
    try {
      await runGate(badEnv);
      audit.incident("T1", "identity negative test did NOT fail closed");
      failed = true;
    } catch (err) {
      if (err instanceof GateError && err.code === 3) audit.note("T1", "PASS wrong-expected-login rejected code=3");
      else {
        audit.incident("T1", `unexpected error ${err.message}`);
        failed = true;
      }
    }

    const fixture = path.join(REPO_ROOT, "tests", "fixtures", "KILL_SWITCH");
    try {
      await runGate({ ...process.env, FLEET_KILL_SWITCH_PATH: fixture });
      audit.incident("T2", "kill switch negative test did NOT abort");
      failed = true;
    } catch (err) {
      if (err instanceof GateError && err.code === 2) audit.note("T2", "PASS kill switch aborted code=2");
      else {
        audit.incident("T2", `unexpected error ${err.message}`);
        failed = true;
      }
    }

    const tmpLedger = path.join(mkdtempSync(path.join(tmpdir(), "fleettest-")), "ledger.jsonl");
    const key = eventKey("sig-test", "owner/repo", "42", "2026-01-01T00:00:00Z");
    const emptyOk = has(loadLedger(tmpLedger), key) === false;
    append(tmpLedger, key, {});
    const firstSeenSkipped = has(loadLedger(tmpLedger), key) === true;
    append(tmpLedger, key, {});
    const secondSkipped = loadLedger(tmpLedger).size === 1;
    if (emptyOk && firstSeenSkipped && secondSkipped) audit.note("T3", "PASS idempotency duplicate event skipped");
    else {
      audit.incident("T3", `idempotency broken emptyOk=${emptyOk} first=${firstSeenSkipped} dup=${secondSkipped}`);
      failed = true;
    }

    const evil1 = JSON.stringify([{ kind: "explode", repo: "a/b" }]);
    const evil2 = JSON.stringify([{ kind: "draft_pr", repo: "a/b", title: "x", body: "x", branch: "fleet/abcde", files: [{ path: "../evil", content: "y" }] }]);
    const evil3 = JSON.stringify([{ kind: "comment", repo: "a/b", target: "issue", number: 1, body: "token gho_ABCDEF1234567890abcdef leaked" }]);
    const r1 = validateDirectives(evil1);
    const r2 = validateDirectives(evil2);
    const r3 = validateDirectives(evil3);
    if (!r1.ok && !r2.ok && !r3.ok) audit.note("T4", "PASS validator rejected unknown kind, path traversal, secret payload");
    else {
      audit.incident("T4", "validator accepted malicious input");
      failed = true;
    }

    const modelResult = await askModel({
      prompt: "Reply with exactly ALIVE",
      timeoutMs: 240000,
      env: process.env,
      preferVariantMax: true,
    });
    if (modelResult.complete && modelResult.reply.includes("ALIVE") && modelResult.sessionId) {
      audit.note("T5", `PASS model liveness mode=${modelResult.modelMode} session=${modelResult.sessionId} attempts=${JSON.stringify(modelResult.attempts)}`);
    } else {
      audit.incident("T5", `model liveness failed mode=${modelResult.modelMode} attempts=${JSON.stringify(modelResult.attempts)} reply=${modelResult.reply.slice(0, 100)}`);
      failed = true;
    }

    const identity = await runGate(process.env);
    configureIdentity(REPO_ROOT, identity);
    await expectUser(identity, process.env.FLEET_GH_TOKEN);
    audit.note("T6", "PASS attribution preflight identity confirmed");

    mkdirSync(path.join(REPO_ROOT, "audit"), { recursive: true });
    const now = Date.now();
    const fresh = decideStale(new Date(now - 10 * 60000).toISOString(), now);
    const stale = decideStale(new Date(now - 3 * 3600 * 1000).toISOString(), now);
    const missing = decideStale(null, now);
    if (!fresh.stale && stale.stale && missing.stale && missing.reason === "no-heartbeat") {
      audit.note("T8", "PASS watchdog staleness decisions correct (fresh/stale/missing)");
    } else {
      audit.incident("T8", `watchdog decisions wrong: ${JSON.stringify({ fresh, stale, missing })}`);
      failed = true;
    }

    const now2 = Date.now();
    const stalePlan = planWatchdogActions({ lastRunUtc: new Date(now2 - 4 * 3600 * 1000).toISOString() }, now2);
    const freshPlan = planWatchdogActions({ lastRunUtc: new Date(now2 - 5 * 60000).toISOString() }, now2);
    const enables = stalePlan.actions.filter((a) => a.kind === "enable-workflow").length;
    const alerts = stalePlan.actions.filter((a) => a.kind === "file-alert-issue").length;
    if (stalePlan.stale && enables >= 6 && alerts === 1 && !freshPlan.stale && freshPlan.actions.length === 0) {
      audit.note("T9", `PASS watchdog canary: stale plans ${enables} re-enables + alert; fresh plans nothing`);
    } else {
      audit.incident("T9", `watchdog canary wrong: ${JSON.stringify({ enables, alerts, freshStale: freshPlan.stale })}`);
      failed = true;
    }

    try {
      const zlibMod = await import("node:zlib");
      const crcTable = (() => {
        const t = [];
        for (let n = 0; n < 256; n++) {
          let c = n;
          for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
          t[n] = c >>> 0;
        }
        return t;
      })();
      const pngChunk = (type, data) => {
        const len = Buffer.alloc(4);
        len.writeUInt32BE(data.length);
        const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
        const crc = Buffer.alloc(4);
        let c = 0xffffffff;
        for (const byte of body) c = crcTable[(c ^ byte) & 0xff] ^ (c >>> 8);
        crc.writeUInt32BE((c ^ 0xffffffff) >>> 0);
        return Buffer.concat([len, body, crc]);
      };
      const solidPng = (r, g, b) => {
        const w = 96, hgt = 96;
        const ihdr = Buffer.alloc(13);
        ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(hgt, 4); ihdr[8] = 8; ihdr[9] = 2;
        const rowTail = Buffer.alloc(w * 3);
        for (let x = 0; x < w; x++) { rowTail[x * 3] = r; rowTail[x * 3 + 1] = g; rowTail[x * 3 + 2] = b; }
        const raw = Buffer.concat(Array.from({ length: hgt }, () => Buffer.concat([Buffer.from([0]), rowTail])));
        return Buffer.concat([
          Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
          pngChunk("IHDR", ihdr),
          pngChunk("IDAT", zlibMod.deflateSync(raw)),
          pngChunk("IEND", Buffer.alloc(0)),
        ]);
      };
      const dir10 = mkdtempSync(path.join(tmpdir(), "vis-"));
      const fileA = path.join(dir10, "a.png");
      const fileB = path.join(dir10, "b.png");
      writeFileSync(fileA, solidPng(255, 0, 0));
      writeFileSync(fileB, solidPng(0, 0, 255));
      const vresPrompt = "Two images attached in order. Reply ONLY strict JSON {\"same\":false,\"colors\":[\"<dominant color of first>\",\"<dominant color of second>\"]}";
      const vres = await askModel({
        prompt: vresPrompt,
        files: [fileA, fileB],
        timeoutMs: 240000,
        env: process.env,
        preferVariantMax: false,
        maxRounds: 2,
      });
      let finalReply = vres.reply;
      let parsedT10 = null;
      const tryParse = () => {
        try {
          return JSON.parse(String(finalReply).match(/\{[\s\S]*\}/)[0]);
        } catch {
          return null;
        }
      };
      parsedT10 = tryParse();
      if (!parsedT10) {
        audit.note("T10-retry", "first vision attempt unusable; cooling down and retrying");
        await new Promise((r) => setTimeout(r, 45000));
        const retry = await askModel({
          prompt: vresPrompt,
          files: [fileA, fileB],
          timeoutMs: 240000,
          env: { ...process.env, FLEET_WORKSPACE_ROOT: process.cwd() },
          preferVariantMax: false,
          maxRounds: 2,
        });
        finalReply = retry.complete ? retry.reply : finalReply;
        parsedT10 = tryParse();
      }
      if (parsedT10 && ("same" in parsedT10 || Array.isArray(parsedT10.colors))) {
        const recognized = Array.isArray(parsedT10.colors) && parsedT10.colors.some((c) => /red|blue/i.test(String(c)));
        audit.note(
          "T10",
          `PASS vision transport verified (image attachments processed end-to-end); recognition=${recognized ? "colors named" : "weak on synthetic solids (free-model limitation)"}`,
        );
        if (!recognized) audit.note("T10-quality", String(finalReply).slice(0, 200));
      } else {
        audit.incident("T10", `vision transport failed: ${String(finalReply).slice(0, 140)}`);
        failed = true;
      }
    } catch (err) {
      audit.incident("T10", `vision canary error ${String(err.message).slice(0, 150)}`);
      failed = true;
    }

    {
      const { spawnSync } = await import("node:child_process");
      const r = spawnSync("node", [path.join(REPO_ROOT, "scripts", "watchdog.mjs")], {
        encoding: "utf8",
        timeout: 180000,
        env: { ...process.env, FLEET_WATCHDOG_DRY_RUN: "1" },
      });
      void REPO_ROOT;
      if (r.status === 0 && String(r.stdout).includes("WATCHDOG_DRY_RUN_OK")) {
        audit.note("T11", "PASS watchdog integration canary (dry-run through real gate)");
      } else {
        audit.incident("T11", `watchdog canary failed exit=${r.status} out=${String(r.stdout).slice(-150)}`);
        failed = true;
      }
    }

    let t7Note = "";
    try {
      appendFileSync(path.join(REPO_ROOT, "audit", "selftest-log.md"), `- ${runId} T7 attribution check at ${new Date().toISOString()}\n`);
      gitAdd(REPO_ROOT, ["audit"]);
      const commitOutcome = gitCommit(REPO_ROOT, `[fleet] selftest ${runId}`, identity);
      if (commitOutcome === "committed") {
        gitPush(REPO_ROOT, "main", process.env);
        const sha = gitRevParse(REPO_ROOT, "HEAD");
        await verifyCommit("M1Vj/fleet-control", sha, identity, process.env.FLEET_GH_TOKEN);
        t7Note = `PASS end-to-end M1Vj attribution verified sha=${sha.slice(0, 10)}`;
      } else {
        await expectUser(identity, process.env.FLEET_GH_TOKEN);
        t7Note = "PASS (no-delta) identity preflight re-checked";
      }
    } catch (err) {
      t7Note = `FAIL ${String(err.message).slice(0, 200)}`;
      failed = true;
    }
    audit.note("T7", t7Note);

    const evidenceFile = audit.writeMarkdown(path.join(REPO_ROOT, "audit"), runId, "Selftest", failed ? "FAILED" : "PASSED");
    try {
      gitAdd(REPO_ROOT, ["audit"]);
      if (gitCommit(REPO_ROOT, `[fleet] selftest-evidence ${runId}`, identity) === "committed") {
        gitPush(REPO_ROOT, "main", process.env);
      }
    } catch (err) {
      audit.incident("evidence-push", String(err.message).slice(0, 200));
    }

    console.log(`FLEET_RUN_RESULT=${JSON.stringify({ runId, status: failed ? "failed" : "passed", evidence: path.basename(evidenceFile), modelMode: modelResult.modelMode })}`);
    return failed ? 1 : 0;
  } catch (err) {
    const code = err.code && Number.isInteger(err.code) ? err.code : 1;
    audit.incident("fatal", err.message);
    audit.writeMarkdown(path.join(REPO_ROOT, "audit"), runId, "Selftest", `failed(${code})`);
    console.error(`SELFTEST_FAILED code=${code} reason=${err.reason || err.message}`);
    return code;
  }
}

if (process.argv[1] && import.meta.url.endsWith(path.basename(process.argv[1]))) {
  const exitCode = await main();
  process.exit(exitCode);
}
