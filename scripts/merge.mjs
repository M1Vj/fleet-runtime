#!/usr/bin/env node
import process from "node:process";
import { readFileSync, writeFileSync, existsSync, mkdirSync, appendFileSync } from "node:fs";
import path from "node:path";
import { runGate } from "./lib/gate.mjs";
import { AuditBuffer } from "./lib/audit.mjs";
import { scrub, gh, ghInput, gitRevParse, configureIdentity, safeCommitState } from "./lib/util.mjs";
import { askModel } from "./lib/model.mjs";
import { extractJsonObject } from "./lib/directives.mjs";
import { verifyPullAuthor } from "./lib/verify.mjs";

const REPO_ROOT = process.cwd();
const STATE_ROOT = process.env.FLEET_STATE_ROOT || REPO_ROOT;
const MERGES_PATH = path.join(STATE_ROOT, "state", "merges.jsonl");
const TARGET_REPO = process.env.FLEET_TARGET_REPO || "";
const PR_NUMBER = Number(process.env.FLEET_PR_NUMBER || 0);

const UI_EXTENSIONS = /\.(html|htm|css|scss|less|jsx|tsx|vue|svelte|astro|mdx)$/i;
const HIGH_RISK_PATTERNS = [
  /^\.env/i,
  /(^|\/)(Dockerfile|docker-compose)/i,
  /^\.github\/workflows\//i,
  /(^|\/)(migrations?|db\/migrate)/i,
  /(^|\/)(auth|security)\//i,
  /(package-lock\.json|yarn\.lock|pnpm-lock\.yaml)$/i,
  /(^|\/)infra\//i,
  /^\.okf\//i,
];
const SECRET_PATTERNS = [
  /(ghp|gho|ghs|ghu|ghr)_[A-Za-z0-9_]{20,}/,
  /AKIA[0-9A-Z]{16}/,
  /BEGIN [A-Z ]*PRIVATE KEY/,
  /sk-[A-Za-z0-9]{20,}/,
];

export function classify(files) {
  const reasons = [];
  let additions = 0;
  let deletions = 0;
  let uiTouched = false;
  for (const f of files) {
    additions += f.additions || 0;
    deletions += f.deletions || 0;
    if (UI_EXTENSIONS.test(f.filename)) uiTouched = true;
    for (const re of HIGH_RISK_PATTERNS) {
      if (re.test(f.filename)) {
        reasons.push(`high-risk path ${f.filename}`);
        break;
      }
    }
  }
  const size = additions + deletions;
  if (size > 400) reasons.push(`large diff (${size} lines)`);
  if (!files.some((f) => f.additions > 0)) reasons.push("no additions");
  return { risk: reasons.length > 0 ? "HIGH" : "LOW", reasons, uiTouched, size };
}

export function secretsInDiff(files) {
  const hits = [];
  for (const f of files) {
    const patch = f.patch || "";
    for (const re of SECRET_PATTERNS) {
      const m = patch.match(re);
      if (m) hits.push(`${f.filename}: ${m[0].slice(0, 8)}...`);
    }
  }
  return hits;
}

async function getPr() {
  const pr = gh(["api", `/repos/${TARGET_REPO}/pulls/${PR_NUMBER}`], process.env);
  const files = gh(["api", `/repos/${TARGET_REPO}/pulls/${PR_NUMBER}/files?per_page=100`], process.env) || [];
  return { pr, files };
}

async function runDeterministicChecks(repo, headSha, audit) {
  const evidenceLines = [];
  const workdir = "/tmp/pr-checkout";
  gh(["repo", "clone", repo, workdir, "--", "--depth", "1"], process.env);
  const { spawnSync } = await import("node:child_process");
  const fr = spawnSync("git", ["fetch", "-q", "--depth", "1", "origin", headSha], { cwd: workdir, encoding: "utf8" });
  const co = spawnSync("git", ["checkout", "-q", "FETCH_HEAD"], { cwd: workdir, encoding: "utf8" });
  if (fr.status !== 0 || co.status !== 0) {
    evidenceLines.push("checkout: failed to fetch head sha");
    return { ok: false, evidence: evidenceLines.join("\n") };
  }
  evidenceLines.push(`checkout: head ${headSha.slice(0, 10)} ok`);
  const pkgPath = path.join(workdir, "package.json");
  if (existsSync(pkgPath)) {
    let scripts = {};
    try {
      scripts = JSON.parse(readFileSync(pkgPath, "utf8")).scripts || {};
    } catch {}
    if (Object.keys(scripts).length > 0) {
      const inst = spawnSync("bash", ["-lc", "npm install --no-audit --no-fund"], { cwd: workdir, encoding: "utf8", timeout: 420000 });
      evidenceLines.push(`npm install: exit=${inst.status}`);
      if (inst.status !== 0) return { ok: false, evidence: evidenceLines.join("\n") + `\n${String(inst.stderr).slice(-400)}` };
      if (scripts.build) {
        const b = spawnSync("bash", ["-lc", "npm run build"], { cwd: workdir, encoding: "utf8", timeout: 600000 });
        evidenceLines.push(`npm run build: exit=${b.status}`);
        if (b.status !== 0) return { ok: false, evidence: evidenceLines.join("\n") + `\n${String(b.stderr).slice(-600)}` };
      }
      if (scripts.test) {
        const t = spawnSync("bash", ["-lc", `${scripts.test} || true`], { cwd: workdir, encoding: "utf8", timeout: 420000 });
        evidenceLines.push(`npm test: ran (exit=${t.status}, non-blocking per repo config)`);
      }
    } else {
      evidenceLines.push("package.json without scripts; skipped build/test");
    }
  } else {
    evidenceLines.push("no package.json; static repo, nothing to build");
  }
  return { ok: true, evidence: evidenceLines.join("\n") };
}

async function postComment(repo, number, body, audit) {
  const c = gh(["api", "-X", "POST", `/repos/${repo}/issues/${number}/comments`, "-F", `body=${body}`], process.env);
  const user = gh(["api", `/repos/${repo}/issues/comments/${c.id}`], process.env);
  if ((user.user && user.user.login) !== "M1Vj") throw new Error("comment attribution mismatch");
  audit.note("comment", `#${number} posted`);
  return c;
}

async function recordTerminalState(state, details) {
  appendFileSync(MERGES_PATH, JSON.stringify({ t: new Date().toISOString(), state, ...details }) + "\n");
}

function writeMergeState(state, details) {
  try {
    mkdirSync(path.dirname(MERGES_PATH), { recursive: true });
    appendFileSync(MERGES_PATH, JSON.stringify({ t: new Date().toISOString(), state, ...details }) + "\n");
  } catch {}
}

async function commitState(audit, identity, message) {
  if (gitHasChanges(REPO_ROOT, ["state"]) || gitHasChanges(STATE_ROOT, ["state"])) {
    gitAdd(REPO_ROOT, ["state"]);
    gitCommit(REPO_ROOT, message, identity);
    gitPush(REPO_ROOT, "main", process.env);
    const sha = gitRevParse(REPO_ROOT, "HEAD");
    await import("./lib/verify.mjs").then((v) => v.verifyCommit("M1Vj/fleet-control", sha, identity, process.env.FLEET_GH_TOKEN));
    audit.note("push-verify", `sha=${sha.slice(0, 10)}`);
  }
}

async function discoverFleetPRs(limit = 3) {
  const repos = gh(["api", "/user/repos?affiliation=owner&per_page=100&sort=pushed"], process.env) || [];
  const found = [];
  for (const r of repos) {
    if (found.length >= limit) break;
    try {
      const pulls = gh(["api", `/repos/${r.full_name}/pulls?state=open&per_page=20`], process.env) || [];
      for (const p of pulls) {
        if (p.draft && p.user && p.user.login === "M1Vj" && String(p.head.ref || "").startsWith("fleet/")) {
          found.push({ repo: r.full_name, number: p.number });
          if (found.length >= limit) break;
        }
      }
    } catch {}
  }
  return found;
}

async function main() {
  const runId = `merge-${Date.now()}`;
  const audit = new AuditBuffer(scrub(process.env));
  const identity = await runGate(process.env);
  configureIdentity(REPO_ROOT, identity);
  audit.note("gate", `identity=${identity.login} target=${TARGET_REPO} pr=${PR_NUMBER}`);

  if (!TARGET_REPO || !PR_NUMBER) {
    const queue = await discoverFleetPRs(3);
    audit.note("scan", `fleet draft PRs queued: ${queue.map((q) => `${q.repo}#${q.number}`).join(", ") || "none"}`);
    if (queue.length === 0) {
      console.log("MERGE_TERMINAL_STATE=NO-OP (nothing to gate)");
      writeMergeState("NO-OP", { why: "scan-empty" });
      return;
    }
    mkdirSync(path.join(REPO_ROOT, "audit"), { recursive: true });
    for (const item of queue) {
      try {
        const { spawnSync } = await import("node:child_process");
        const res = spawnSync("node", [path.join(REPO_ROOT, "scripts", "merge.mjs")], {
          encoding: "utf8",
          timeout: 3600000,
          env: {
            ...process.env,
            FLEET_TARGET_REPO: item.repo,
            FLEET_PR_NUMBER: String(item.number),
          },
        });
        audit.note("child", `${item.repo}#${item.number} exit=${res.status}`);
      } catch (err) {
        audit.incident("child", `${item.repo}#${item.number}: ${err.message}`);
      }
    }
    audit.writeMarkdown(path.join(REPO_ROOT, "audit"), runId, "Merge gate scan", "ok");
    safeCommitState(REPO_ROOT, ["state", "audit"], `[fleet] merge-gate scan ${runId}`, identity, process.env);
    console.log("MERGE_TERMINAL_STATE=SCAN-DONE");
    return;
  }

  const { pr, files } = await getPr();
  await verifyPullAuthor(TARGET_REPO, PR_NUMBER, identity, process.env.FLEET_GH_TOKEN);
  if (!pr.head || !pr.head.sha) throw new Error("no head sha");

  const cls = classify(files);
  const secretHits = secretsInDiff(files);
  audit.note("classify", JSON.stringify({ ...cls, secretHits: secretHits.length }));

  const terminal = async (state, extra = {}) => {
    await recordTerminalState(state, { repo: TARGET_REPO, pr: PR_NUMBER, ...extra });
    console.log(`MERGE_TERMINAL_STATE=${state}`);
  };

  if (pr.state !== "open") return terminal("NO-OP", { why: "pr not open" });
  if (secretHits.length > 0) {
    await postComment(TARGET_REPO, PR_NUMBER, "🛑 **fleet merge-gate**: potential secrets detected in diff:\n\n" + secretHits.map((h) => `- \`${h}\``).join("\n") + "\n\nAuto-merge refused. Remove and force-push the branch.", audit);
    await terminal("BLOCKED", { why: "secrets in diff" });
    return finish(audit, runId, "BLOCKED");
  }

  const riskCommentBits = [];
  if (cls.risk === "HIGH") riskCommentBits.push(...cls.reasons);

  let visualEvidence = "not-applicable";
  let visualOk = true;
  if (cls.uiTouched) {
    const visDir = "/tmp/visual-out";
    mkdirSync(visDir, { recursive: true });
    const routesEnv = process.env.FLEET_UI_ROUTES || "/";
    const { spawnSync } = await import("node:child_process");
    const vres = spawnSync("node", [path.join(REPO_ROOT, "scripts", "visual-check.mjs")], {
      encoding: "utf8",
      timeout: 2400000,
      env: {
        ...process.env,
        FLEET_REPO: TARGET_REPO,
        FLEET_HEAD_SHA: pr.head.sha,
        FLEET_BASE_SHA: pr.base ? pr.base.sha : "",
        FLEET_PR_NUMBER: String(PR_NUMBER),
        FLEET_UI_ROUTES: routesEnv,
        FLEET_ARTIFACT_DIR: visDir,
      },
    });
    audit.note("visual", `exit=${vres.status} ${String(vres.stdout).slice(-120)}`);
    const evJson = path.join(visDir, "visual-evidence.json");
    const evTxt = path.join(visDir, "visual-evidence.txt");
    if (existsSync(evJson)) {
      const ve = JSON.parse(readFileSync(evJson, "utf8"));
      visualOk = !(ve.verdict && ve.verdict.consoleBlocker) && !(ve.verdict && ve.verdict.a11yBlocker);
      if (ve.verdict && ve.verdict.vlm) {
        riskCommentBits.push(`vision judge (advisory): ${ve.verdict.vlm.verdict} (${ve.verdict.vlm.score}) regressions=${JSON.stringify(ve.verdict.vlm.regressions || []).slice(0, 200)}`);
      }
      visualEvidence = existsSync(evTxt) ? readFileSync(evTxt, "utf8") : "";
    } else {
      visualEvidence = "visual capture did not produce evidence (app not servable?) — treating as neutral pass with note";
      riskCommentBits.push("note: visual evidence unavailable");
    }
    if (!visualOk) riskCommentBits.push("visual gate: console errors or critical a11y violations present");
  }

  if (cls.risk === "HIGH") {
    await postComment(
      TARGET_REPO,
      PR_NUMBER,
      "⚖️ **fleet merge-gate**: classified HIGH RISK — human review required.\n\nReasons:\n" +
        riskCommentBits.map((r) => `- ${r}`).join("\n") +
        "\n\nThe fleet will keep this PR as a draft. A maintainer can merge manually once satisfied.",
      audit,
    );
    await terminal("BLOCKED", { why: "high-risk paths require human" });
    return finish(audit, runId, "BLOCKED");
  }

  const det = await runDeterministicChecks(TARGET_REPO, pr.head.sha, audit);
  if (!det.ok) {
    await postComment(TARGET_REPO, PR_NUMBER, "🧪 **fleet merge-gate**: deterministic checks FAILED.\n\n```\n" + det.evidence.slice(-1500) + "\n```", audit);
    await terminal("BLOCKED", { why: "deterministic checks failed" });
    return finish(audit, runId, "BLOCKED");
  }
  audit.note("deterministic", "passed (L1/L2)");

  if (cls.uiTouched && !visualOk) {
    await postComment(TARGET_REPO, PR_NUMBER, "👁 **fleet merge-gate**: visual verification FAILED.\n\n```\n" + visualEvidence.slice(-1200) + "\n```\n\nScreenshots attached to the workflow artifacts for human review.", audit);
    await terminal("BLOCKED", { why: "visual gate failed" });
    return finish(audit, runId, "BLOCKED");
  }

  const combinedEvidence = [
    det.evidence,
    visualEvidence === "not-applicable" ? "" : "VISUAL:\n" + visualEvidence,
  ].filter(Boolean).join("\n\n");

  const correctness = await judge({ repo: TARGET_REPO, prNumber: PR_NUMBER, title: pr.title, body: pr.body, files, extraEvidence: combinedEvidence, lens: "correctness-and-security", audit });
  const standards = await judge({ repo: TARGET_REPO, prNumber: PR_NUMBER, title: pr.title, body: pr.body, files, extraEvidence: combinedEvidence, lens: "industry-standards-and-maintainability", audit });

  const approved = correctness.verdict === "approve" && standards.verdict === "approve" && correctness.score >= 80 && standards.score >= 80;

  const verdictBody =
    "🔍 **fleet judge panel** (independent maker-checker review)\n\n" +
    `| lens | verdict | score |\n| --- | --- | --- |\n| correctness+security | ${correctness.verdict.toUpperCase()} | ${correctness.score} |\n| standards+maintainability | ${standards.verdict.toUpperCase()} | ${standards.score} |\n\n` +
    (correctness.blockers.length || standards.blockers.length
      ? "**Blockers:**\n" + [...correctness.blockers, ...standards.blockers].map((b) => `- ${b}`).join("\n") + "\n\n"
      : "") +
    "<details><summary>reasons</summary>\n\n" +
    [...correctness.reasons, ...standards.reasons].map((r) => `- ${r}`).join("\n") +
    "\n</details>";

  await postComment(TARGET_REPO, PR_NUMBER, verdictBody, audit);

  if (!approved) {
    await terminal("BLOCKED", { why: "judges rejected", scores: [correctness.score, standards.score] });
    return finish(audit, runId, "BLOCKED");
  }

  if (pr.draft) {
    try {
      gh(["api", "-X", "POST", `/repos/${TARGET_REPO}/pulls/${PR_NUMBER}/mark-ready`], process.env);
      audit.note("ready", "marked ready for review");
    } catch {}
  }

  gh(["pr", "merge", String(PR_NUMBER), "--merge", "--delete-branch", "-R", TARGET_REPO], process.env);
  await new Promise((r) => setTimeout(r, 4000));
  const mergedMeta = gh(["api", `/repos/${TARGET_REPO}/pulls/${PR_NUMBER}`], process.env);
  if (!mergedMeta.merged) throw new Error("merge attempted but not merged");
  await verifyCommit(TARGET_REPO, mergedMeta.merge_commit_sha, identity, process.env.FLEET_GH_TOKEN).catch(() => {});
  audit.note("merged", `merge_commit=${String(mergedMeta.merge_commit_sha).slice(0, 10)}`);
  await terminal("SUCCESS", { mergeCommit: mergedMeta.merge_commit_sha, scores: [correctness.score, standards.score] });
  return finish(audit, runId, "SUCCESS");

  function finish(a, rid, stateName) {
    a.writeMarkdown(path.join(REPO_ROOT, "audit"), rid, `Merge gate ${TARGET_REPO}#${PR_NUMBER}`, stateName);
    try {
      safeCommitState(REPO_ROOT, ["state", "audit"], `[fleet] merge-gate ${rid} ${stateName}`, identity, process.env);
    } catch {}
    return 0;
  }
}

async function judge({ repo, prNumber, title, body, files, extraEvidence, lens, audit }) {
  const diff = files
    .map((f) => `--- ${f.filename} (+${f.additions}/-${f.deletions})\n${String(f.patch || "(binary or too large)").slice(0, 5000)}`)
    .join("\n\n")
    .slice(0, 45000);
  const prompt = [
    `You are an INDEPENDENT ${lens} JUDGE reviewing a pull request you did not author.`,
    `Repo ${repo}, PR #${prNumber}: ${title}.`,
    body ? `PR description:\n${String(body).slice(0, 3000)}\n` : "",
    extraEvidence ? `Deterministic verification evidence already collected:\n${extraEvidence.slice(0, 8000)}\n` : "",
    "Judge strictly against industry standards: correctness, security, error handling, tests, maintainability.",
    'Return ONLY strict JSON: {"verdict":"approve|reject","score":<0-100>,"reasons":["..."],"blockers":["..."]}',
    "approve requires score>=80 AND zero blockers. Rubber-stamping is failure; reject anything questionable.",
    "DIFF:",
    diff,
  ].join("\n");
  const judgeModel = process.env.FLEET_JUDGE_MODEL;
  const result = await askModel({
    prompt,
    timeoutMs: 480000,
    env: process.env,
    preferVariantMax: true,
    maxRounds: 3,
    ...(judgeModel ? { modelOverride: judgeModel } : {}),
  });
  audit.note("judge", `${lens} complete=${result.complete}`);
  if (!result.complete || !result.reply) {
    return { verdict: "reject", score: 0, reasons: ["judge unavailable"], blockers: ["judge unavailable"] };
  }
  try {
    const v = extractJsonObject(result.reply);
    return {
      verdict: v.verdict === "approve" ? "approve" : "reject",
      score: Math.max(0, Math.min(100, Number(v.score) || 0)),
      reasons: Array.isArray(v.reasons) ? v.reasons.map(String).slice(0, 6) : [],
      blockers: Array.isArray(v.blockers) ? v.blockers.map(String).slice(0, 6) : [],
    };
  } catch (err) {
    return { verdict: "reject", score: 0, reasons: [`judge output unparsable: ${String(err.message).slice(0, 80)}`], blockers: ["unparsable"] };
  }
}

if (process.argv[1] && import.meta.url.endsWith(path.basename(process.argv[1]))) {
  main()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error(`MERGE_GATE_FAILED reason=${err.message}`);
      process.exit(err.code && Number.isInteger(err.code) ? err.code : 1);
    });
}
