import { spawn } from "node:child_process";

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

export function runOnce({ prompt, sessionId, variant, timeoutMs, env }) {
  return new Promise((resolve) => {
    const missing = !env.FLEET_OPENCODE_AUTH;
    const args = ["run", "--format", "json", "-m", "opencode/x-preview-f-free"];
    if (env.FLEET_OPENCODE_DEBUG === "1") args.push("--print-logs", "--log-level", "DEBUG");
    if (!missing && variant) args.push("--variant", variant);
    if (!missing && sessionId) args.push("-s", sessionId);
    args.push(prompt);
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const childEnv = { ...env };
    delete childEnv.FLEET_GH_TOKEN;
    childEnv.OPENCODE_AUTH_CONTENT = env.FLEET_OPENCODE_AUTH || "";
    childEnv.OPENCODE_DISABLE_AUTOUPDATE = "1";
    const child = spawn("opencode", args, { env: childEnv, stdio: ["ignore", "pipe", "pipe"] });
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

export async function askModel({ prompt, sessionId, timeoutMs = 480000, env = process.env, preferVariantMax = true, maxRounds = 4 }) {
  let sid = sessionId || "";
  let mode = preferVariantMax ? "max" : "plain";
  let useAuth = true;
  let promptNow = prompt;
  const attempts = [];
  for (let round = 1; round <= maxRounds; round++) {
    if (round > 1) {
      const backoff = Math.round(20000 + Math.random() * 15000);
      await sleep(backoff);
    }
    const roundEnv = useAuth ? env : stripAuth(env);
    const r = await runOnce({ prompt: promptNow, sessionId: sid || undefined, variant: mode === "max" ? "max" : undefined, timeoutMs, env: roundEnv });
    attempts.push({
      round,
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
      return { reply: r.reply, sessionId: sid, modelMode: mode === "max" && !useAuth ? "plain-anon" : mode === "max" ? "max" : useAuth ? "plain" : "plain-anon", attempts, complete: true };
    }
    if (r.spawnFailed) {
      return { reply: "", sessionId: sid, modelMode: mode, attempts, complete: false, fatal: true };
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

function stripAuth(env) {
  const clone = { ...env };
  delete clone.FLEET_OPENCODE_AUTH;
  delete clone.OPENCODE_AUTH_CONTENT;
  return clone;
}
