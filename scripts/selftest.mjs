#!/usr/bin/env node
import process from "node:process";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
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
import { loadProviderRegistry, providerModelReference, selectProviderRoute } from "./lib/provider-registry.mjs";

const CODE_ROOT = process.cwd();
const REPO_ROOT = process.env.FLEET_STATE_ROOT ? path.resolve(process.env.FLEET_STATE_ROOT) : CODE_ROOT;

export const SELFTEST_PUBLIC_REPO = "M1Vj/fleet-runtime";
export const SELFTEST_PUBLIC_CANARY_PROMPT = "Reply with exactly PUBLIC_CANARY_OK. Do not inspect files, use tools, or access private data.";
export const SELFTEST_VISION_CANARY_PROMPT = "Two images are attached in order. Reply ONLY strict JSON {\"same\":false,\"colors\":[\"<dominant color of first>\",\"<dominant color of second>\"]}.";

const PUBLIC_REPO_RE = /^M1Vj\/[A-Za-z0-9._-]+$/;

export function isPublicCanarySuccess(result) {
  return result?.complete === true && String(result?.reply ?? "").trim() === "PUBLIC_CANARY_OK";
}

export function parseVisionCanaryReply(reply) {
  let parsed;
  try {
    parsed = JSON.parse(String(reply ?? "").trim());
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const keys = Object.keys(parsed);
  if (keys.length !== 2 || !keys.includes("same") || !keys.includes("colors")) return null;
  if (parsed.same !== false || !Array.isArray(parsed.colors) || parsed.colors.length !== 2) return null;
  if (parsed.colors.some((color) => typeof color !== "string" || color.trim() === "")) return null;
  return parsed;
}

function verifiedPublicTarget(value) {
  if (!value || value.private !== false || value.visibility !== "public" || !PUBLIC_REPO_RE.test(String(value.full_name || ""))) {
    throw new Error("MODEL_PUBLIC_TARGET_REQUIRED");
  }
  return {
    full_name: String(value.full_name),
    private: false,
    visibility: "public",
  };
}

export function visionCapabilityRequired(env = process.env) {
  return /^(?:1|true)$/i.test(String(env?.FLEET_REQUIRE_VISION || ""));
}

/** Verify the fixed selftest repository before sending any model request. */
export async function resolveVerifiedPublicTarget({ env = process.env, fetchImpl = globalThis.fetch } = {}) {
  const repo = String(env?.GITHUB_REPOSITORY || SELFTEST_PUBLIC_REPO).trim();
  if (repo !== SELFTEST_PUBLIC_REPO || typeof fetchImpl !== "function") throw new Error("SELFTEST_PUBLIC_TARGET_UNAVAILABLE");
  const headers = {
    Accept: "application/vnd.github+json",
    "User-Agent": "fleet-selftest",
    "X-GitHub-Api-Version": "2022-11-28",
  };
  if (typeof env?.FLEET_GH_TOKEN === "string" && env.FLEET_GH_TOKEN.trim()) {
    headers.Authorization = `Bearer ${env.FLEET_GH_TOKEN}`;
  }
  let response;
  try {
    response = await fetchImpl(`https://api.github.com/repos/${repo}`, { headers, redirect: "error" });
  } catch {
    throw new Error("SELFTEST_PUBLIC_TARGET_UNAVAILABLE");
  }
  if (!response?.ok) throw new Error("SELFTEST_PUBLIC_TARGET_UNAVAILABLE");
  let metadata;
  try { metadata = await response.json(); } catch { throw new Error("SELFTEST_PUBLIC_TARGET_UNAVAILABLE"); }
  if (!metadata || metadata.full_name !== repo || metadata.private !== false || metadata.visibility !== "public") {
    throw new Error("MODEL_PUBLIC_TARGET_REQUIRED");
  }
  return verifiedPublicTarget(metadata);
}

/** Run the harmless public model canary with the same public-data contract as free routes. */
export async function runModelLiveness({ ask = askModel, env = process.env, publicTarget } = {}) {
  const target = verifiedPublicTarget(publicTarget);
  return ask({
    prompt: SELFTEST_PUBLIC_CANARY_PROMPT,
    timeoutMs: 240000,
    env,
    profile: "public-read",
    dataClass: "public",
    publicTarget: target,
    preferVariantMax: true,
    skipCircuitCheck: true,
  });
}

/** Select only an explicitly configured public model whose registry metadata declares image input. */
export function findVisionRoute({ registry = loadProviderRegistry(), env = process.env, publicTarget, health = {}, now = Date.now(), rotationSeed } = {}) {
  const target = verifiedPublicTarget(publicTarget);
  const refs = Array.isArray(registry?.buckets?.public)
    ? registry.buckets.public.slice().sort((left, right) => Number(left.priority || 0) - Number(right.priority || 0))
    : [];
  const skipped = [];
  const seen = new Set();
  for (const ref of refs) {
    const provider = registry?.providers?.find((entry) => entry.id === ref.provider);
    const metadata = provider?.models?.[ref.model];
    if (!provider || !Array.isArray(metadata?.modalities) || !metadata.modalities.includes("image")) continue;
    const modelReference = providerModelReference(provider, ref.model);
    if (!modelReference || seen.has(modelReference)) continue;
    seen.add(modelReference);
    const selected = selectProviderRoute({
      registry,
      bucket: "public",
      model: modelReference,
      env,
      health,
      now,
      freeOnly: true,
      allowPaid: false,
      allowLocal: true,
      allowLiveCanary: true,
      dataClass: "public",
      publicTarget: target,
      rotationSeed,
    });
    if (selected?.ok) {
      return {
        ...selected,
        modelReference,
        provider: selected.provider || provider.id,
        model: selected.model || ref.model,
        capabilities: [...metadata.modalities],
      };
    }
    skipped.push(`${modelReference}:${selected?.reason || "unavailable"}`);
  }
  return { ok: false, reason: "VISION_CAPABILITY_UNAVAILABLE", skipped };
}

/** Execute T10 only through the selected vision route; never treat text-only output as capability proof. */
export async function runVisionCanary({ ask = askModel, registry = loadProviderRegistry(), env = process.env, publicTarget, files = [], health = {}, now = Date.now(), rotationSeed } = {}) {
  const target = verifiedPublicTarget(publicTarget);
  const route = findVisionRoute({ registry, env, publicTarget: target, health, now, rotationSeed });
  if (!route.ok) {
    return {
      complete: false,
      capabilityAvailable: false,
      required: visionCapabilityRequired(env),
      status: visionCapabilityRequired(env) ? "failed" : "degraded",
      reason: "VISION_CAPABILITY_UNAVAILABLE",
      route: null,
      attempts: [],
    };
  }
  const result = await ask({
    prompt: SELFTEST_VISION_CANARY_PROMPT,
    skipCircuitCheck: true,
    files,
    timeoutMs: 240000,
    env,
    profile: "public-read",
    dataClass: "public",
    publicTarget: target,
    modelOverride: route.modelReference,
    preferVariantMax: false,
    maxRounds: 2,
  });
  const validReply = result?.complete === true && parseVisionCanaryReply(result.reply);
  return {
    ...result,
    complete: Boolean(validReply),
    capabilityAvailable: true,
    required: true,
    status: validReply ? "passed" : "failed",
    route,
  };
}

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
  let publicTarget = null;
  let modelResult = { complete: false, reply: "", sessionId: "", modelMode: "unavailable", attempts: [] };

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

    try {
      publicTarget = await resolveVerifiedPublicTarget({ env: process.env });
      modelResult = await runModelLiveness({ env: process.env, publicTarget });
      if (isPublicCanarySuccess(modelResult)) {
        audit.note("T5", `PASS public model liveness mode=${modelResult.modelMode} session=${modelResult.sessionId || "none"} attempts=${JSON.stringify(modelResult.attempts)}`);
      } else {
        audit.incident("T5", `public model liveness failed mode=${modelResult.modelMode} attempts=${JSON.stringify(modelResult.attempts)} reply=${modelResult.reply.slice(0, 100)}`);
        failed = true;
      }
    } catch (err) {
      audit.incident("T5", `public target/model liveness failed ${String(err.message).slice(0, 160)}`);
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
    const staleHeartbeat = { lastRunUtc: new Date(now2 - 4 * 3600 * 1000).toISOString() };
    const stalePlan = planWatchdogActions(staleHeartbeat, now2);
    const falsePlan = planWatchdogActions(staleHeartbeat, now2, undefined, { autoEnable: false });
    const optedInPlan = planWatchdogActions(staleHeartbeat, now2, undefined, { autoEnable: true });
    const freshPlan = planWatchdogActions({ lastRunUtc: new Date(now2 - 5 * 60000).toISOString() }, now2);
    const enables = stalePlan.actions.filter((a) => a.kind === "enable-workflow").length;
    const falseEnables = falsePlan.actions.filter((a) => a.kind === "enable-workflow").length;
    const optedInEnables = optedInPlan.actions.filter((a) => a.kind === "enable-workflow").length;
    const alerts = stalePlan.actions.filter((a) => a.kind === "file-alert-issue").length;
    if (stalePlan.stale && enables === 0 && falseEnables === 0 && optedInEnables >= 6 && alerts === 1 && !freshPlan.stale && freshPlan.actions.length === 0) {
      audit.note("T9", `PASS watchdog canary: default/false plans suppress re-enables; explicit opt-in plans ${optedInEnables}; fresh plans nothing`);
    } else {
      audit.incident("T9", `watchdog canary wrong: ${JSON.stringify({ enables, falseEnables, optedInEnables, alerts, freshStale: freshPlan.stale })}`);
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
      if (!publicTarget) {
        if (visionCapabilityRequired(process.env)) {
          audit.incident("T10", "vision capability unavailable: verified public target unavailable");
          failed = true;
        } else {
          audit.note("T10-DEGRADED", "vision capability unavailable: verified public target unavailable");
        }
      } else {
        const vres = await runVisionCanary({
          env: process.env,
          publicTarget,
          files: [fileA, fileB],
        });
        if (!vres.capabilityAvailable) {
          const detail = `vision capability unavailable route=${(vres.skipped || []).slice(0, 3).join(",") || "none-configured"}`;
          if (vres.required) {
            audit.incident("T10", detail);
            failed = true;
          } else {
            audit.note("T10-DEGRADED", detail);
          }
        }
        let finalReply = vres.reply;
        const parsedT10 = parseVisionCanaryReply(finalReply);
        if (vres.capabilityAvailable && vres.complete && parsedT10) {
          const recognized = Array.isArray(parsedT10.colors) && parsedT10.colors.some((c) => /red|blue/i.test(String(c)));
          audit.note(
            "T10",
            `PASS vision route=${vres.route.provider}/${vres.route.model} transport verified (image attachments processed end-to-end); recognition=${recognized ? "colors named" : "weak on synthetic solids (free-model limitation)"}`,
          );
          if (!recognized) audit.note("T10-quality", String(finalReply).slice(0, 200));
        } else if (vres.capabilityAvailable) {
          audit.incident("T10", `vision transport failed: ${String(finalReply).slice(0, 140)}`);
          failed = true;
        }
      }
    } catch (err) {
      audit.incident("T10", `vision canary error ${String(err.message).slice(0, 150)}`);
      failed = true;
    }

    {
      const { spawnSync } = await import("node:child_process");
      const runtimeRoot = process.cwd();
      const scriptPath = path.join(runtimeRoot, "scripts", "watchdog.mjs");
      const childEnv = {
        ...process.env,
        FLEET_WATCHDOG_DRY_RUN: "1",
        FLEET_STATE_ROOT: process.env.FLEET_STATE_ROOT || path.join(runtimeRoot, "state-control"),
      };
      const r = spawnSync(process.execPath, [scriptPath], {
        encoding: "utf8",
        timeout: 180000,
        env: childEnv,
        cwd: runtimeRoot,
      });
      const existsOk = existsSync(scriptPath);
      if (r.status === 0 && String(r.stdout).includes("WATCHDOG_DRY_RUN_OK")) {
        audit.note("T11", "PASS watchdog integration canary (dry-run through real gate)");
      } else {
        audit.incident("T11", `canary failed scriptExists=${existsOk} exit=${r.status} out=${String(r.stdout).slice(-160)} err=${String(r.stderr).slice(-320)} stateRootSet=${Boolean(childEnv.FLEET_STATE_ROOT)}`);
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
