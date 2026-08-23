#!/usr/bin/env node
import process from "node:process";
import { writeFileSync, mkdirSync, existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

const req = createRequire(import.meta.url);

const OUT_DIR = process.env.FLEET_ARTIFACT_DIR || ".";
const REPO = process.env.FLEET_REPO || "";
const HEAD_SHA = process.env.FLEET_HEAD_SHA || "";
const BASE_SHA = process.env.FLEET_BASE_SHA || "";
const PR_NUMBER = process.env.FLEET_PR_NUMBER || "";
const ROUTES = (process.env.FLEET_UI_ROUTES || "/").split(",").map((r) => r.trim()).filter(Boolean);
const VIEWPORTS = [
  { name: "desktop", width: 1280, height: 800 },
  { name: "mobile", width: 390, height: 844 },
];

function sh(cmd, args, opts = {}) {
  const res = req("node:child_process").spawnSync(cmd, args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: opts.timeout || 300000,
    cwd: opts.cwd,
  });
  return { code: res.status, stdout: res.stdout || "", stderr: res.stderr || "" };
}

function globalRoot() {
  return sh("npm", ["root", "-g"]).stdout.trim();
}

function resolvePlaywright() {
  for (const base of [process.env.NODE_PATH, globalRoot()].filter(Boolean)) {
    try {
      return req(path.join(base, "playwright"));
    } catch {}
  }
  throw new Error("playwright not found in global modules");
}

async function main() {
  if (process.env.FLEET_GH_TOKEN && !process.env.GH_TOKEN) process.env.GH_TOKEN = process.env.FLEET_GH_TOKEN;
  mkdirSync(OUT_DIR, { recursive: true });
  const evidence = [];
  const playwright = resolvePlaywright();
  const { chromium } = playwright;
  const browser = await chromium.launch({ headless: true });

  function workdirFor(label) {
    return path.join("/tmp", `vis-${label}-${PR_NUMBER}`);
  }

  function fetchRef(label, sha) {
    const dir = workdirFor(label);
    sh("rm", ["-rf", dir]);
    mkdirSync(dir, { recursive: true });
    sh("git", ["init", "-q"], { cwd: dir });
    sh("git", ["remote", "add", "origin", `https://github.com/${REPO}.git`], { cwd: dir });
    {
      const helperDir = path.join(dir, "..", "cred");
      mkdirSync(helperDir, { recursive: true });
      const hp = path.join(helperDir, "helper.sh");
      writeFileSync(hp, "#!/bin/sh\nprintf 'username=%s\\n' \"$FLEET_GH_USER\"\nprintf 'password=%s\\n' \"$FLEET_GH_TOKEN\"\n", { mode: 0o700 });
      sh("git", ["config", "credential.helper", hp], { cwd: dir });
    }
    const fr = sh("git", ["fetch", "-q", "--depth", "1", "origin", sha], { cwd: dir, timeout: 240000 });
    if (fr.code !== 0) throw new Error(`fetch ${label} failed: ${fr.stderr.slice(-200)}`);
    sh("git", ["checkout", "-q", "FETCH_HEAD"], { cwd: dir });
    return dir;
  }

  function detectServe(dir) {
    const pkgPath = path.join(dir, "package.json");
    if (existsSync(pkgPath)) {
      let scripts = {};
      try {
        scripts = JSON.parse(readFileSync(pkgPath, "utf8")).scripts || {};
      } catch {}
      if (scripts.build && (scripts.start || scripts.dev)) {
        return { kind: "node", build: "npm run build", start: scripts.start ? "npm start" : "npm run dev" };
      }
    }
    if (existsSync(path.join(dir, "index.html"))) {
      return { kind: "static" };
    }
    return null;
  }

  async function serve(dir, plan) {
    const cp = req("node:child_process");
    if (!plan) return null;
    if (plan.kind === "static") {
      const child = cp.spawn("python3", ["-m", "http.server", "3999"], { cwd: dir, stdio: "ignore" });
      await new Promise((r) => setTimeout(r, 1500));
      return { child, url: "http://127.0.0.1:3999" };
    }
    sh("npm", ["install", "--no-audit", "--no-fund"], { cwd: dir, timeout: 420000 });
    const b = sh("bash", ["-lc", plan.build], { cwd: dir, timeout: 600000 });
    if (b.code !== 0) throw new Error(`build failed: ${b.stderr.slice(-300)}`);
    const child = cp.spawn("bash", ["-lc", `${plan.start}`], { cwd: dir, stdio: "ignore", detached: true });
    await new Promise((r) => setTimeout(r, 13000));
    return { child, url: "http://127.0.0.1:3999" };
  }

  function stopServe(s) {
    if (s && s.child && s.child.pid) {
      try { process.kill(-s.child.pid, "SIGTERM"); } catch { try { s.child.kill("SIGTERM"); } catch {} }
    }
  }

  const context = await browser.newContext();
  const results = [];

  for (const [label, sha] of [["after", HEAD_SHA], ["before", BASE_SHA]]) {
    if (!sha) continue;
    let server = null;
    try {
      const dir = fetchRef(label, sha);
      const plan = detectServe(dir);
      if (!plan) {
        evidence.push(`${label}: no servable app detected; visual gate SKIPPED`);
        continue;
      }
      server = await serve(dir, plan);
      if (!server) {
        evidence.push(`${label}: no server`);
        continue;
      }
      for (const vp of VIEWPORTS) {
        for (const route of ROUTES) {
          const page = await context.newPage();
          await page.setViewportSize({ width: vp.width, height: vp.height });
          let consoleErrors = 0;
          page.on("console", (msg) => { if (msg.type() === "error") consoleErrors += 1; });
          let failedRequests = 0;
          page.on("requestfailed", () => failedRequests += 1);
          const url = server.url + route;
          const resp = await page.goto(url, { waitUntil: "load", timeout: 45000 }).catch(() => null);
          await page.waitForTimeout(2500);
          const shotPath = path.join(OUT_DIR, `${vp.name}_${route.replace(/\W+/g, "_")}_${label}.png`);
          await page.screenshot({ path: shotPath, fullPage: false });
          let a11yCritical = -1;
          try {
            await page.addScriptTag({ url: "https://cdnjs.cloudflare.com/ajax/libs/axe-core/4.10.2/axe.min.js" });
            const axe = await page.evaluate(async () => {
              const r = await window.axe.run(document, { resultTypes: ["violations"] });
              return r.violations.filter((v) => v.impact === "critical").length;
            });
            a11yCritical = axe;
          } catch {}
          const textLen = (await page.evaluate(() => document.body ? document.body.innerText.length : 0));
          const status = resp ? resp.status() : 0;
          results.push({ label, viewport: vp.name, route, status, consoleErrors, failedRequests, a11yCritical, textLen, shot: path.basename(shotPath) });
          evidence.push(`${label}/${vp.name}${route}: status=${status} consoleErrors=${consoleErrors} failedReq=${failedRequests} a11yCritical=${a11yCritical} textLen=${textLen}`);
          await page.close();
        }
      }
    } catch (err) {
      evidence.push(`${label}: ERROR ${String(err.message).slice(0, 200)}`);
    } finally {
      stopServe(server);
    }
  }

  const pairs = {};
  for (const r of results.filter((x) => x.label === "before")) pairs[r.viewport + "|" + r.route] = r.shot;
  for (const r of results.filter((x) => x.label === "after")) {
    const key = r.viewport + "|" + r.route;
    if (pairs[key]) {
      const pct = diffPercent(path.join(OUT_DIR, pairs[key]), path.join(OUT_DIR, r.shot));
      r.diffPct = pct;
      evidence.push(`diff ${r.viewport}${r.route}: ${pct.toFixed(2)}% pixels differ`);
    }
  }

  await browser.close();

  const afterResults = results.filter((r) => r.label === "after");
  const consoleBlocker = afterResults.some((r) => r.consoleErrors > 0);
  const a11yBlocker = afterResults.some((r) => r.a11yCritical > 0);

  let vlm = null;
  try {
    const { askModel } = await import("./lib/model.mjs");
    const pairsForVlm = [];
    for (const r of results.filter((x) => x.label === "after")) {
      const key = r.viewport + "|" + r.route;
      if (pairs[key]) pairsForVlm.push({ viewport: r.viewport, route: r.route, before: path.join(OUT_DIR, pairs[key]), after: path.join(OUT_DIR, r.shot) });
    }
    if (pairsForVlm.length > 0) {
      const first = pairsForVlm[0];
      const vres = await askModel({
        prompt: [
          "You are a UI REGRESSION JUDGE with vision. Attached are two screenshots of the same page at the same viewport: FIRST = BEFORE (base), SECOND = AFTER (proposed change).",
          "Compare them carefully: layout breakage, overlapping/clipped elements, missing content, contrast/readability regressions, broken images/icons.",
          "Intentional content changes are fine; unexplained visual damage is not.",
          'Return ONLY strict JSON: {"verdict":"approve|reject","score":<0-100>,"regressions":["..."],"observations":["..."]}',
          `Context: viewport=${first.viewport}, route=${first.route}.`,
        ].join("\n"),
        files: [first.before, first.after],
        timeoutMs: 300000,
        env: process.env,
        preferVariantMax: false,
        maxRounds: 2,
      });
      auditNote(vres);
      if (vres.complete && vres.reply) {
        try {
          const obj = JSON.parse((String(vres.reply).match(/\{[\s\S]*\}/) || ["{}"])[0].replace(/\n/g, "\\n"));
          vlm = {
            verdict: obj.verdict === "approve" ? "approve" : "reject",
            score: Number(obj.score) || 0,
            regressions: Array.isArray(obj.regressions) ? obj.regressions.slice(0, 6).map(String) : [],
            observations: Array.isArray(obj.observations) ? obj.observations.slice(0, 6).map(String) : [],
          };
        } catch {
          vlm = { verdict: "reject", score: 0, regressions: ["vlm output unparsable"], observations: [] };
        }
      } else {
        vlm = { verdict: "reject", score: 0, regressions: ["vlm unavailable"], observations: [] };
      }
      evidence.push(`vlm verdict=${vlm.verdict} score=${vlm.score} regressions=${JSON.stringify(vlm.regressions)}`);
    }
  } catch (err) {
    evidence.push(`vlm stage error: ${String(err.message).slice(0, 150)}`);
    vlm = { verdict: "reject", score: 0, regressions: ["vlm stage failed"], observations: [] };
  }

  writeFileSync(
    path.join(OUT_DIR, "visual-evidence.json"),
    JSON.stringify({ repo: REPO, pr: PR_NUMBER, results, verdict: { consoleBlocker, a11yBlocker, vlm }, generatedUtc: new Date().toISOString() }, null, 2),
  );
  writeFileSync(path.join(OUT_DIR, "visual-evidence.txt"), evidence.join("\n"));
  console.log(`VISUAL_EVIDENCE_WRITTEN consoleBlocker=${consoleBlocker} a11yBlocker=${a11yBlocker}`);
}

function auditNote(vres) {
  process.stdout.write(`VLM complete=${vres.complete}\n`);
}

function diffPercent(aPath, bPath) {
  try {
    const pngjs = req(path.join(globalRoot(), "pngjs"));
    const pixelmatch = req(path.join(globalRoot(), "pixelmatch"));
    const { PNG } = pngjs;
    const a = PNG.sync.read(readFileSync(aPath));
    const b = PNG.sync.read(readFileSync(bPath));
    if (a.width !== b.width || a.height !== b.height) return 100;
    const numDiff = pixelmatch(a.data, b.data, null, a.width, a.height, { threshold: 0.1 });
    return (numDiff / (a.width * a.height)) * 100;
  } catch {
    return -1;
  }
}
main().then(
  () => process.exit(0),
  (err) => {
    console.error(`VISUAL_FAILED ${err.message}`);
    process.exit(1);
  },
);
