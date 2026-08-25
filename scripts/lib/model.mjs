import { spawn } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { gatewayCircuitOpen, markGatewayDown, markGatewayUp } from "./gateway-health.mjs";
import { classifyProviderAuthFailure, providerAuthStatus } from "./provider-auth.mjs";

export const DISPOSABLE_MODEL_POLICY = Object.freeze({
  permission: {
    "*": "deny",
    read: "deny",
    list: "deny",
    glob: "deny",
    grep: "deny",
    bash: "deny",
    edit: "deny",
    external_directory: "deny",
    webfetch: "deny",
    websearch: "deny",
    task: "deny",
    skill: "deny",
    lsp: "deny",
    question: "deny",
    todowrite: "deny",
  },
});

// The improve loop may inspect a freshly cloned, explicitly public target. It
// still cannot mutate, execute, or reach outside that disposable workspace.
export const PUBLIC_READ_MODEL_POLICY = Object.freeze({
  profile: "public-read",
  permission: {
    "*": "deny",
    read: "allow",
    list: "allow",
    glob: "allow",
    grep: "allow",
    webfetch: "allow",
    bash: "deny",
    edit: "deny",
    external_directory: "deny",
    websearch: "deny",
    task: "deny",
    skill: "deny",
    lsp: "deny",
    question: "deny",
    todowrite: "deny",
  },
});

function policyFor(profile = "deny-all", publicTarget) {
  if (profile === "deny-all") return DISPOSABLE_MODEL_POLICY;
  if (profile !== "public-read") throw new Error("MODEL_POLICY_PROFILE_INVALID");
  if (!publicTarget || publicTarget.private !== false || publicTarget.visibility !== "public") {
    throw new Error("MODEL_PUBLIC_TARGET_REQUIRED");
  }
  return PUBLIC_READ_MODEL_POLICY;
}

function canonicalPath(value) {
  try { return realpathSync(path.resolve(String(value))); } catch { return path.resolve(String(value)); }
}

function isWithin(child, parent) {
  const relative = path.relative(canonicalPath(parent), canonicalPath(child));
  return relative === "" || (relative && !relative.startsWith("..") && !path.isAbsolute(relative));
}

/** Create an explicit, disposable OpenCode cwd that cannot contain private state. */
export function createDisposableModelWorkspace({
  repoRoot = process.cwd(),
  stateRoot = process.env.FLEET_STATE_ROOT || "",
  baseDir = process.env.FLEET_MODEL_TMPDIR || os.tmpdir(),
  prefix = "fleet-model-",
  profile = "deny-all",
  publicTarget,
} = {}) {
  const resolvedRepo = path.resolve(String(repoRoot || process.cwd()));
  const resolvedState = stateRoot ? path.resolve(String(stateRoot)) : "";
  const resolvedBase = path.resolve(String(baseDir || os.tmpdir()));
  const policy = policyFor(profile, publicTarget);
  const workspace = mkdtempSync(path.join(resolvedBase, prefix));
  try {
    if (isWithin(workspace, resolvedRepo) || (resolvedState && isWithin(workspace, resolvedState))) {
      throw new Error("MODEL_WORKSPACE_NOT_ISOLATED");
    }
    chmodSync(workspace, 0o700);
    const policyPath = path.join(workspace, "opencode.json");
    const policyDocument = {
      profile,
      permission: policy.permission,
      ...(profile === "public-read" ? { publicTarget: { private: false, visibility: "public" } } : {}),
    };
    writeFileSync(policyPath, `${JSON.stringify(policyDocument)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
    chmodSync(policyPath, 0o600);
    return workspace;
  } catch (error) {
    rmSync(workspace, { recursive: true, force: true });
    throw error;
  }
}

export function assertDisposableModelWorkspace(workspace, { repoRoot = process.cwd(), stateRoot = process.env.FLEET_STATE_ROOT || "", profile = "deny-all", publicTarget } = {}) {
  const candidate = typeof workspace === "string" && path.isAbsolute(workspace) ? path.resolve(workspace) : "";
  if (!candidate || !existsSync(candidate) || isWithin(candidate, repoRoot || process.cwd())
    || (stateRoot && isWithin(candidate, stateRoot))) {
    throw new Error("MODEL_WORKSPACE_NOT_ISOLATED");
  }
  const candidateStat = lstatSync(candidate);
  if (!candidateStat.isDirectory() || candidateStat.isSymbolicLink()) throw new Error("MODEL_WORKSPACE_NOT_ISOLATED");
  const policyPath = path.join(candidate, "opencode.json");
  if (!existsSync(policyPath)) throw new Error("MODEL_POLICY_REQUIRED");
  try {
    const policyStat = lstatSync(policyPath);
    if (!policyStat.isFile() || policyStat.isSymbolicLink()) throw new Error("MODEL_POLICY_INVALID");
    const policy = JSON.parse(readFileSync(policyPath, "utf8"));
    const expected = policyFor(profile, publicTarget);
    if (policy.profile !== profile || !policy.permission) throw new Error("MODEL_POLICY_PROFILE_MISMATCH");
    for (const [key, value] of Object.entries(expected.permission)) {
      if (policy.permission[key] !== value) throw new Error("MODEL_POLICY_NOT_DENY_ALL");
    }
    if (profile === "public-read" && (policy.publicTarget?.private !== false || policy.publicTarget?.visibility !== "public")) {
      throw new Error("MODEL_PUBLIC_TARGET_REQUIRED");
    }
  } catch (error) {
    if (/MODEL_POLICY_|MODEL_PUBLIC_TARGET_/.test(String(error.message))) throw error;
    throw new Error("MODEL_POLICY_INVALID");
  }
  return candidate;
}

export function disposeModelWorkspace(workspace) {
  if (typeof workspace === "string" && path.isAbsolute(workspace)) rmSync(workspace, { recursive: true, force: true });
}

function deepFind(obj, key, out = []) {
  if (obj === null || typeof obj !== "object") return out;
  if (Array.isArray(obj)) {
    for (const item of obj) deepFind(item, key, out);
    return out;
  }
  for (const [k, v] of Object.entries(obj)) {
    if (k === key && typeof v === "string" && v.length > 0) out.push(v);
    deepFind(v, key, out);
  }
  return out;
}

function collectText(obj, out = []) {
  if (obj === null || typeof obj !== "object") return out;
  if (Array.isArray(obj)) {
    for (const item of obj) collectText(item, out);
    return out;
  }
  for (const [k, v] of Object.entries(obj)) {
    if ((k === "text" || k === "delta") && typeof v === "string") out.push(v);
    else collectText(v, out);
  }
  return out;
}

export function resolveModelChain(env = process.env) {
  const primary = "opencode/x-preview-f-free";
  const raw = String(env.FLEET_MODEL_CHAIN || "").trim();
  if (!raw) return [primary];
  const chain = raw.split(",").map((m) => m.trim()).filter(Boolean);
  return chain.length > 0 ? chain : [primary];
}

export function runOnce({ prompt, sessionId, variant, timeoutMs, env, files = [], model = "opencode/x-preview-f-free", modelOverride, workspace, repoRoot = process.cwd(), stateRoot = env.FLEET_STATE_ROOT || "", spawnImpl = spawn }) {
  return new Promise((resolve) => {
    const missing = !env.FLEET_OPENCODE_AUTH;
    const args = ["run", "--format", "json", "-m", modelOverride || model];
    if (env.FLEET_OPENCODE_DEBUG === "1") args.push("--print-logs", "--log-level", "DEBUG");
    if (!missing && variant) args.push("--variant", variant);
    if (!missing && sessionId) args.push("-s", sessionId);
    args.push(prompt);
    const workspaceRoot = workspace || env.FLEET_WORKSPACE_ROOT || process.cwd();
    const attachmentDir = path.join(workspaceRoot, "attachments");
    let attachmentIndex = 0;
    for (const f of files || []) {
      let attachPath = f;
      try {
        const resolved = path.resolve(f);
        if (!existsSync(resolved)) continue;
        const stat = lstatSync(resolved);
        if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 2 * 1024 * 1024) continue;
        const rel = path.relative(workspaceRoot, resolved);
        if (rel.startsWith("..") || path.isAbsolute(rel)) {
          // Never copy attachments from the repository or private state checkout.
          if (isWithin(resolved, repoRoot) || (stateRoot && isWithin(resolved, stateRoot))) continue;
          mkdirSync(attachmentDir, { recursive: true, mode: 0o700 });
          attachPath = path.join(attachmentDir, `${attachmentIndex += 1}-${path.basename(resolved).replace(/[^A-Za-z0-9._-]/g, "-")}`);
          copyFileSync(resolved, attachPath);
          chmodSync(attachPath, 0o600);
        }
      } catch {}
      if (existsSync(attachPath)) args.push("--file", attachPath);
    }
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const childEnv = { ...env };
    for (const key of Object.keys(childEnv)) {
      if (/TOKEN|SECRET|KEY|PASSWORD|CREDENTIAL/i.test(key) && key !== "OPENCODE_AUTH_CONTENT" && key !== "OPENCODE_API_KEY") delete childEnv[key];
    }
    delete childEnv.FLEET_GH_TOKEN;
    delete childEnv.GH_TOKEN;
    delete childEnv.GDRIVE_REFRESH_TOKEN;
    delete childEnv.GDRIVE_CLIENT_SECRET;
    // Legacy migration path only: owner-Mac OAuth snapshots are never the
    // production dependency; GitHub provisions OPENCODE_API_KEY instead.
    childEnv.OPENCODE_AUTH_CONTENT = env.FLEET_OPENCODE_AUTH || "";
    childEnv.OPENCODE_DISABLE_AUTOUPDATE = "1";
    const child = spawnImpl("opencode", args, { env: childEnv, stdio: ["ignore", "pipe", "pipe"], cwd: workspaceRoot });
    const timer = setTimeout(() => {
      timedOut = true;
      try { child.kill("SIGTERM"); } catch {}
    }, timeoutMs);
    child.stdout.on("data", (d) => { stdout += d.toString(); });
    child.stderr.on("data", (d) => { stderr += d.toString(); });
    child.on("error", (err) => {
      clearTimeout(timer);
      resolve({ reply: "", sessionId: "", exitCode: -1, interrupted: false, stderrTail: String(err.message).slice(-400), spawnFailed: true });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      let reply = "";
      let sid = "";
      try {
        const events = [];
        for (const line of stdout.split("\n")) {
          const trimmed = line.trim();
          if (!trimmed.startsWith("{")) continue;
          try { events.push(JSON.parse(trimmed)); } catch { continue; }
        }
        reply = events.map((e) => collectText(e).join("")).filter(Boolean).join("\n").trim();
        const ids = events.map((e) => deepFind(e, "sessionID")).flat();
        sid = ids[ids.length - 1] || "";
      } catch {
        reply = "";
      }
      if (!reply) {
        const tail = stdout.split("\n").filter((l) => !l.trim().startsWith("{") && l.trim()).join("\n").trim();
        reply = tail.slice(-4000);
      }
      const rawTail = stdout.split("\n").filter(Boolean).slice(-8).join("\n").slice(-1200);
      resolve({
        reply,
        sessionId: sid,
        exitCode: code ?? -1,
        interrupted: timedOut,
        stderrTail: stderr.slice(-400),
        rawTail,
        spawnFailed: false,
        authMissing: missing,
      });
    });
  });
}

function sleep(ms) {
  return new Promise((res) => setTimeout(res, ms));
}

async function askModelInternal({ prompt, sessionId, timeoutMs = 480000, env = process.env, preferVariantMax = true, maxRounds = 4, files = [], modelOverride, workspace, repoRoot = process.cwd(), stateRoot: privateStateRoot = env.FLEET_STATE_ROOT || "", spawnImpl, skipCircuitCheck = false }) {
  const healthRoot = env.FLEET_STATE_ROOT || process.cwd();
  const authStatus = providerAuthStatus(env, { circuitOpen: !skipCircuitCheck && !sessionId && gatewayCircuitOpen(healthRoot) });
  if (!authStatus.ready) {
    return authStatus.stage === "credentials"
      ? { reply: "", sessionId: "", modelMode: "auth-missing", attempts: [{ round: 0, skipped: "model-auth-missing" }], complete: false, authMissing: true }
      : { reply: "", sessionId: "", modelMode: "circuit-open", attempts: [{ round: 0, skipped: "circuit-open" }], complete: false, circuitOpen: true };
  }
  const chain = modelOverride ? [modelOverride] : resolveModelChain(env);
  const allAttempts = [];
  let lastSid = sessionId || "";
  let lastMode = "";
  let lastAuthState = "";
  for (let ci = 0; ci < chain.length; ci++) {
    const r = await askOnModel({ model: chain[ci], isPrimary: ci === 0, prompt, sessionId: lastSid || undefined, timeoutMs, env, preferVariantMax, maxRounds, files, workspace, repoRoot, stateRoot: privateStateRoot, spawnImpl });
    allAttempts.push(...(r.attempts || []));
    if (r.sessionId) lastSid = r.sessionId;
    lastMode = r.modelMode || lastMode;
    lastAuthState = r.authState || lastAuthState;
    if (r.complete) {
      try { markGatewayUp(healthRoot); } catch {}
      return { reply: r.reply, sessionId: lastSid, modelMode: lastMode, attempts: allAttempts, complete: true };
    }
    if (lastAuthState) break;
  }
  try { markGatewayDown(healthRoot, allAttempts.map((x) => x.errTail || "").join(" ").slice(-200)); } catch {}
  return {
    reply: "",
    sessionId: lastSid,
    modelMode: lastMode,
    attempts: allAttempts,
    complete: false,
    ...(lastAuthState ? { authState: lastAuthState } : {}),
  };
}

/** Every judge/revision call gets a fresh workspace and policy by default. */
export async function askModel(opts = {}) {
  const env = opts.env || process.env;
  const profile = opts.profile || "deny-all";
  const publicTarget = opts.publicTarget;
  const workspace = opts.workspace || createDisposableModelWorkspace({
    repoRoot: opts.repoRoot || process.cwd(),
    stateRoot: opts.stateRoot || env.FLEET_STATE_ROOT || "",
    profile,
    publicTarget,
  });
  const owned = !opts.workspace;
  assertDisposableModelWorkspace(workspace, {
    repoRoot: opts.repoRoot || process.cwd(),
    stateRoot: opts.stateRoot || env.FLEET_STATE_ROOT || "",
    profile,
    publicTarget,
  });
  try {
    return await askModelInternal({ ...opts, env, workspace, repoRoot: opts.repoRoot || process.cwd(), stateRoot: opts.stateRoot || env.FLEET_STATE_ROOT || "" });
  } finally {
    if (owned) disposeModelWorkspace(workspace);
  }
}

function stripAuth(env) {
  const clone = { ...env };
  delete clone.FLEET_OPENCODE_AUTH;
  delete clone.OPENCODE_AUTH_CONTENT;
  return clone;
}

async function askOnModel({ model, isPrimary, prompt, sessionId, timeoutMs, env, preferVariantMax, maxRounds, files, workspace, repoRoot, stateRoot: privateStateRoot, spawnImpl }) {
  const healthRoot = env.FLEET_STATE_ROOT || process.cwd();
  let sid = sessionId || "";
  let mode = preferVariantMax && isPrimary ? "max" : "plain";
  let useAuth = true;
  let promptNow = prompt;
  const attempts = [];
  for (let round = 1; round <= maxRounds; round++) {
    if (round > 1) {
      const backoff = Math.round(20000 + Math.random() * 15000);
      await sleep(backoff);
    }
    const roundEnv = useAuth ? env : stripAuth(env);
    const r = await runOnce({ prompt: promptNow, sessionId: sid || undefined, variant: mode === "max" ? "max" : undefined, timeoutMs, env: roundEnv, files, model, workspace, repoRoot, stateRoot: privateStateRoot, spawnImpl });
    attempts.push({
      round,
      model,
      mode,
      auth: useAuth ? "yes" : "anon",
      exit: r.exitCode,
      interrupted: r.interrupted,
      gotReply: Boolean(r.reply),
      hadSession: Boolean(r.sessionId),
      errTail: (r.stderrTail || "").slice(-160),
      rawTail: (r.rawTail || "").slice(-300),
    });
    if (r.sessionId) sid = r.sessionId;
    if (!r.interrupted && r.exitCode === 0 && r.reply) {
      try { markGatewayUp(healthRoot); } catch {}
      return { reply: r.reply, sessionId: sid, modelMode: `${model}${mode === "max" ? "@max" : ""}`, attempts, complete: true };
    }
    const authState = classifyProviderAuthFailure(`${r.stderrTail || ""}\n${r.rawTail || ""}`);
    if (authState) {
      return { reply: "", sessionId: sid, modelMode: mode, attempts, complete: false, authState };
    }
    if (mode === "max") {
      mode = "plain";
      continue;
    }
    if (useAuth) {
      useAuth = false;
      sid = "";
      promptNow = prompt;
      continue;
    }
    promptNow = "You were interrupted mid-task. Continue from where you stopped and finish the job. Output ONLY the requested final answer now.";
    sid = "";
  }
  return { reply: "", sessionId: sid, modelMode: mode, attempts, complete: false };
}

export async function askModelResilient(opts) {
  const first = await askModel(opts);
  if (first.complete || first.authState || first.authMissing) return { ...first, ladders: 1 };
  const cooldownMs = opts.cooldownMs ?? 90000;
  await new Promise((r) => setTimeout(r, cooldownMs));
  const second = await askModel({ ...opts, maxRounds: Math.max(2, (opts.maxRounds || 4) - 1) });
  return { ...second, ladders: 2 };
}
