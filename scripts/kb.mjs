#!/usr/bin/env node
import process from "node:process";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import { runGate } from "./lib/gate.mjs";
import { AuditBuffer } from "./lib/audit.mjs";
import { scrub, gh, ghInput, putFileContent, ensureBranch, findExistingOpenPr, gitAdd, gitCommit, gitPush, gitHasChanges, gitRevParse, sha256, configureIdentity } from "./lib/util.mjs";
import { askModel, askModelResilient } from "./lib/model.mjs";
import { verifyCommit, verifyPullAuthor } from "./lib/verify.mjs";
import { buildMemoryDigest } from "./lib/fleet-memory.mjs";

const CODE_ROOT = process.cwd();
const REPO_ROOT = process.env.FLEET_STATE_ROOT ? path.resolve(process.env.FLEET_STATE_ROOT) : CODE_ROOT;
export const KB_REPO = "M1Vj/vj-knowledge-base";

const KB_DOMAINS = ["identity", "projects", "knowledge-conversations", "skills", "places", "devices", "work", "education", "interests", "people"];
const FORBIDDEN_PREFIXES = [".okf/", "raw/", "raw-vault/", ".github/"];

function kbPathAllowed(p) {
  if (typeof p !== "string" || p.includes("..") || p.startsWith("/")) return false;
  const lower = p.toLowerCase();
  if (FORBIDDEN_PREFIXES.some((pre) => lower.startsWith(pre))) return false;
  if (!lower.endsWith(".md")) return false;
  if (["security.md", "agents.md", "readme.md"].includes(lower)) return false;
  const top = lower.split("/")[0];
  if (!KB_DOMAINS.includes(top)) return false;
  return true;
}

function hasValidFrontmatter(content) {
  const m = String(content).match(/^---\n([\s\S]*?)\n---\n/);
  if (!m) return false;
  const fm = m[1];
  for (const key of ["type:", "title:", "description:", "tags:", "timestamp:"]) {
    if (!fm.includes(key)) return false;
  }
  return true;
}

function listKbTree() {
  const meta = gh(["api", `/repos/${KB_REPO}`], process.env);
  const branch = meta.default_branch;
  const ref = gh(["api", `/repos/${KB_REPO}/git/ref/heads/${branch}`], process.env);
  const tree = gh(["api", `/repos/${KB_REPO}/git/trees/${ref.object.sha}?recursive=1`], process.env) || {};
  return {
    defaultBranch: branch,
    baseSha: ref.object.sha,
    files: (tree.tree || []).filter((t) => t.type === "blob" && t.path.endsWith(".md")).map((t) => t.path).slice(0, 600),
  };
}

function fetchKeyKbText(paths) {
  const priority = ["index.md", ...KB_DOMAINS.map((d) => `${d}/index.md`), ".okf/HANDOFF.md", ".okf/completeness-audit.md"];
  const chosen = priority.filter((p) => paths.includes(p)).slice(0, 14);
  const out = [];
  for (const p of chosen) {
    try {
      const raw = gh(["api", "-H=Accept: application/vnd.github.raw", `/repos/${KB_REPO}/contents/${p}`], process.env);
      out.push(`===== ${p} =====\n${String(raw).slice(0, 10000)}`);
    } catch {}
  }
  return out.join("\n\n").slice(0, 70000);
}

async function modeInventory(audit) {
  await runGate(process.env);
  { const { gatewayDown } = await import("./lib/gateway-health.mjs"); if (gatewayDown(process.env.FLEET_STATE_ROOT || process.cwd())) { console.log("KB_SKIPPED=circuit-open"); return 0; } }
  const treeInfo = listKbTree();
  const digest = [
    `KB markdown inventory (${treeInfo.files.length} files):`,
    treeInfo.files.join("\n").slice(0, 24000),
    "",
    "Key index/handoff excerpts:",
    fetchKeyKbText(treeInfo.files),
  ].join("\n");
  const prompt = [
    "You are the dedicated Knowledge-Base synthesis agent for Vj's personal OKF knowledge base.",
    "Study the inventory and excerpts. Find: missing cross-links between domains, stale claims needing re-verification (look for 'Active (YYYY-MM)' snapshots), duplicate/overlapping files to merge, empty stubs needing content, and entirely missing topics that the existing material implies.",
    "Return ONLY strict JSON: {\"findings\":\"...\",\"opportunities\":[{\"title\":\"...\",\"kind\":\"new-file|improve-file|merge|crosslink\",\"target_path\":\"<kb path>\",\"plan\":\"...\"}]} max 10, deepest synthesis quality.",
    digest,
  ].join("\n");
  const result = await askModel({ prompt, timeoutMs: 600000, env: process.env, preferVariantMax: true, maxRounds: 4 });
  audit.note("inventory", `complete=${result.complete}`);
  if (!result.complete || !result.reply) throw Object.assign(new Error("MODEL_UNAVAILABLE"), { code: 6, reason: "MODEL_UNAVAILABLE" });
  const dir = process.env.FLEET_ARTIFACT_DIR || ".";
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, "kb-inventory.json"), JSON.stringify({ reply: result.reply }, null, 2));
  console.log("KB_DONE=inventory");
  return 0;
}

async function gdriveFetchIfConfigured(audit) {
  const refreshToken = process.env.GDRIVE_REFRESH_TOKEN || "";
  const clientId = process.env.GDRIVE_CLIENT_ID || "";
  const clientSecret = process.env.GDRIVE_CLIENT_SECRET || "";
  if (!refreshToken || !clientId || !clientSecret) {
    audit.note("gdrive", "DRIVE_NOT_CONFIGURED (owner must set GDRIVE_REFRESH_TOKEN / GDRIVE_CLIENT_ID / GDRIVE_CLIENT_SECRET secrets)");
    console.log("KB_GDRIVE=not-configured");
    return null;
  }
  try {
    const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: clientId,
        client_secret: clientSecret,
        refresh_token: refreshToken,
        grant_type: "refresh_token",
      }),
    });
    if (!tokenRes.ok) throw new Error(`token refresh failed ${tokenRes.status}`);
    const { access_token } = await tokenRes.json();
    const folderId = process.env.GDRIVE_FOLDER_ID || "root";
    const listRes = await fetch(
      `https://www.googleapis.com/drive/v3/files?q='${folderId}'+in+parents+and+mimeType contains 'text/'&pageSize=20&fields=files(id,name,mimeType)`,
      { headers: { Authorization: `Bearer ${access_token}` } },
    );
    if (!listRes.ok) throw new Error(`drive list failed ${listRes.status}`);
    const { files } = await listRes.json();
    const outDir = path.join(REPO_ROOT, "docs", "gdrive-inbox");
    mkdirSync(outDir, { recursive: true });
    let fetched = 0;
    for (const f of (files || []).slice(0, 10)) {
      const dl = await fetch(`https://www.googleapis.com/drive/v3/files/${f.id}?alt=media`, {
        headers: { Authorization: `Bearer ${access_token}` },
      });
      if (!dl.ok) continue;
      const text = await dl.text();
      writeFileSync(path.join(outDir, f.name.replace(/[^\w.-]+/g, "_")), text.slice(0, 80000));
      fetched += 1;
    }
    audit.note("gdrive", `fetched=${fetched}`);
    console.log(`KB_GDRIVE=fetched:${fetched}`);
    return fetched;
  } catch (err) {
    audit.incident("gdrive", String(err.message).slice(0, 200));
    console.log("KB_GDRIVE=error");
    return null;
  }
}

async function modeSynthesize(audit) {
  await runGate(process.env);
  // Deterministic pre-model step: publish the fleet memory digest BEFORE any
  // model-gated skip so it still ships during gateway outages.
  publishFleetMemoryDigest(audit);
  await gdriveFetchIfConfigured(audit);
  {
    const { gatewayDown } = await import("./lib/gateway-health.mjs");
    if (gatewayDown(process.env.FLEET_STATE_ROOT || process.cwd())) {
      console.log("KB_SKIPPED=circuit-open");
      return 0;
    }
  }
  const dir = process.env.FLEET_ARTIFACT_DIR || ".";
  const invPath = path.join(dir, "kb-inventory.json");
  let surveyText = "";
  if (existsSync(invPath)) surveyText = JSON.parse(readFileSync(invPath, "utf8")).reply;

  const inboxDir = path.join(REPO_ROOT, "docs", "gdrive-inbox");
  let inboxNote = "No Drive material available.";
  if (existsSync(inboxDir)) {
    const names = readdirSafe(inboxDir);
    if (names.length > 0) {
      inboxNote = `Drive-derived notes present (${names.length}): synthesize these into proper OKF domain files where valuable:\n` +
        names.slice(0, 8).map((n) => `----- ${n} -----\n` + readFileSync(path.join(inboxDir, n), "utf8").slice(0, 6000)).join("\n\n");
    }
  }

  const treeInfo = listKbTree();
  const prompt = [
    "You are the KB synthesis genius agent. Produce NEW or improved OKF knowledge-base markdown files.",
    "STRICT RULES: every file begins with YAML frontmatter containing type:, title:, description:, tags: (list), timestamp: (ISO). Cross-link related concepts with relative links like [text](/domain/file.md). Never touch .okf/, raw/, raw-vault/, SECURITY.md, AGENTS.md. Only paths under these domains: " + KB_DOMAINS.join(", ") + ".",
    "Prefer depth over breadth: full synthesized files (300+ words each) grounded ONLY in the provided context; mark speculation clearly; never invent facts about Vj that are absent from context.",
    "Respond in EXACTLY this plain-text format:",
    "KB",
    "TITLE: <package title>",
    "SUMMARY: <what this improves>",
    "RISKS: <one line>",
    "Then per file:",
    "FILE path=<domain>/<name>.md",
    "```",
    "<complete file content including frontmatter>",
    "```",
    "At most 6 files; each up to 40000 chars.",
    "",
    "INVENTORY FINDINGS:",
    surveyText.slice(0, 20000),
    "",
    "DRIVE MATERIAL:",
    inboxNote.slice(0, 30000),
    "",
    "EXISTING FILE LIST:",
    treeInfo.files.join("\n").slice(0, 10000),
  ].join("\n");

  const result = await askModelResilient({ prompt, timeoutMs: 600000, env: process.env, preferVariantMax: true, maxRounds: 5 });
  audit.note("synthesize", `complete=${result.complete} ladders=${result.ladders}`);
  if (!result.complete || !result.reply) throw Object.assign(new Error("MODEL_UNAVAILABLE"), { code: 6, reason: "MODEL_UNAVAILABLE" });

  let files = [];
  const headered = [];
  const matches = [...result.reply.matchAll(/^FILE path=(.+)$/gm)];
  for (const m of matches) {
    const p = m[1].trim().replace(/^["']|["']$/g, "");
    const after = result.reply.slice(m.index + m[0].length);
    const fence = after.match(/```[a-zA-Z0-9]*\n([\s\S]*?)\n```/);
    if (fence) headered.push({ path: p, content: fence[1] });
  }
  if (headered.length > 0) files = headered;
  else files = harvestFencedFiles(result.reply);
  const errors = [];
  if (files.length === 0 || files.length > 6) errors.push("file count invalid");
  for (const f of files) {
    if (!kbPathAllowed(f.path)) errors.push(`path rejected: ${f.path}`);
    if (!hasValidFrontmatter(f.content)) errors.push(`bad frontmatter: ${f.path}`);
    if (f.content.length > 40000) errors.push(`too large: ${f.path}`);
  }
  if (errors.length > 0 && result.sessionId) {
    audit.note("kb-repair", errors.slice(0, 5).join("; "));
    const repair = await askModel({
      prompt: "Your previous answer violated the KB format rules (" + errors.slice(0, 3).join("; ") + "). Re-output corrected package in EXACTLY the same plain-text format (KB / TITLE:/SUMMARY:/RISKS:/ FILE path= blocks). Ensure frontmatter has type,title,description,tags,timestamp and paths start with an allowed domain.",
      sessionId: result.sessionId,
      timeoutMs: 480000,
      env: process.env,
      preferVariantMax: false,
      maxRounds: 3,
    });
    if (repair.complete && repair.reply) {
      const rm = [...repair.reply.matchAll(fileRe)];
      const rfiles = [];
      for (let i = 0; i < rm.length; i++) {
        const p = rm[i][1].trim();
        const after = repair.reply.slice(rm[i].index + rm[i][0].length);
        const fence = after.match(/```[a-zA-Z0-9]*\n([\s\S]*?)\n```/);
        if (fence) rfiles.push({ path: p, content: fence[1] });
      }
      const rerrs = [];
      for (const f of rfiles) {
        if (!kbPathAllowed(f.path)) rerrs.push(f.path);
        if (!hasValidFrontmatter(f.content)) rerrs.push(f.path + ":fm");
      }
      if (rfiles.length > 0 && rerrs.length === 0) {
        files.splice(0, files.length, ...rfiles);
        errors.splice(0, errors.length);
      }
    }
    if ((errors.length > 0 || files.length === 0)) {
      audit.note("kb-fresh", "repair failed; fresh-session attempt");
      const fresh = await askModel({
        prompt,
        timeoutMs: 480000,
        env: process.env,
        preferVariantMax: false,
        maxRounds: 3,
      });
      if (fresh.complete && fresh.reply) {
        const fm = [...fresh.reply.matchAll(fileRe)];
        const ffiles = [];
        for (let i = 0; i < fm.length; i++) {
          const p = fm[i][1].trim();
          const after = fresh.reply.slice(fm[i].index + fm[i][0].length);
          const fence = after.match(/```[a-zA-Z0-9]*\n([\s\S]*?)\n```/);
          if (fence) ffiles.push({ path: p, content: fence[1] });
        }
        const ferrs = [];
        for (const f of ffiles) {
          if (!kbPathAllowed(f.path)) ferrs.push(f.path);
          if (!hasValidFrontmatter(f.content)) ferrs.push(f.path + ":fm");
        }
        if (ffiles.length > 0 && ferrs.length === 0) {
          files.splice(0, files.length, ...ffiles);
          errors.splice(0, errors.length);
        }
      }
    }
  }
  if (errors.length > 0 || files.length === 0) {
    audit.incident("validate", errors.slice(0, 6).join("; ") || "no files");
    throw Object.assign(new Error("KB_PACKAGE_REJECTED"), { code: 5 });
  }
  writeFileSync(path.join(dir, "kb-package.json"), JSON.stringify({ files }, null, 2));
  console.log(`KB_FILES=${files.length}`);
  return 0;
}

function readdirSafe(d) {
  try {
    return requireFs().readdirSync(d).filter((n) => !n.startsWith("."));
  } catch {
    return [];
  }
}
function requireFs() {
  return fsModule;
}
import * as fsModule from "node:fs";

const MEMORY_DIGEST_PATH = "fleet/memory-digest.md";
const MEMORY_DIGEST_BRANCH = "fleet/kb-memory-digest";

/** Read the private fleet memory pages; tolerant of a missing state checkout. */
function readFleetMemorySnapshot(stateRoot = REPO_ROOT) {
  const memoryDir = path.join(stateRoot, "state", "memory");
  const universalPath = path.join(memoryDir, "UNIVERSAL.md");
  const reposDir = path.join(memoryDir, "repos");
  const universalMd = existsSync(universalPath) ? readFileSync(universalPath, "utf8") : "";
  const repoPages = [];
  for (const name of readdirSafe(reposDir).filter((n) => n.endsWith(".md")).sort()) {
    try {
      repoPages.push({ file: name.replace(/\.md$/, ""), md: readFileSync(path.join(reposDir, name), "utf8") });
    } catch {}
  }
  return { universalMd, repoPages };
}

/**
 * Deterministic pre-model bridge to the owner's personal knowledge base:
 * distill the private fleet memory into one committed OKF file and publish it
 * through the existing ensureBranch + putFileContent + findExistingOpenPr
 * pattern (so duplicate PRs never open). Runs BEFORE the circuit-open skip so
 * the digest still ships during model outages. Best-effort: failures are
 * audit notes and never fail the KB lane.
 */
function publishFleetMemoryDigest(audit) {
  try {
    const { universalMd, repoPages } = readFleetMemorySnapshot();
    const digest = buildMemoryDigest({
      universalMd,
      repoPages,
      timestampUtc: new Date().toISOString(),
      maxUniversalEntries: 30,
    });
    const treeInfo = listKbTree();
    ensureBranch(KB_REPO, MEMORY_DIGEST_BRANCH, treeInfo.baseSha, process.env);
    putFileContent(KB_REPO, MEMORY_DIGEST_PATH, digest, MEMORY_DIGEST_BRANCH, "[fleet-kb] fleet operational memory digest", process.env);
    const body = [
      "## fleet-kb operational memory digest",
      "",
      `**File:** \`${MEMORY_DIGEST_PATH}\``,
      "",
      "_Autonomous distilled digest of the private fleet operational memory (bounded, redacted, `[private]` repos excluded). Auto-generated by the M1Vj fleet-control KB agent. Review before merging._",
    ].join("\n");
    let pr = findExistingOpenPr(KB_REPO, MEMORY_DIGEST_BRANCH, process.env);
    if (!pr) {
      try {
        pr = ghInput(
          ["api", "-X", "POST", `/repos/${KB_REPO}/pulls`],
          { title: "[fleet-kb] fleet operational memory digest", body, head: MEMORY_DIGEST_BRANCH, base: treeInfo.defaultBranch, draft: true },
          process.env,
        );
      } catch (err) {
        pr = findExistingOpenPr(KB_REPO, MEMORY_DIGEST_BRANCH, process.env);
        if (!pr) throw err;
      }
    }
    audit.note("kb-digest", `published path=${MEMORY_DIGEST_PATH} repos=${repoPages.length} pr=${pr && pr.number}`);
    return pr;
  } catch (error) {
    audit.note("kb-digest", `digest publish skipped: ${String(error.message || error).slice(0, 160)}`);
    return null;
  }
}

async function modeShip(audit) {
  const identity = await runGate(process.env);
  configureIdentity(REPO_ROOT, identity);
  const dir = process.env.FLEET_ARTIFACT_DIR || ".";
  const pkgPath = path.join(dir, "kb-package.json");
  if (!existsSync(pkgPath)) {
    console.log("KB_SKIP=no-package");
    return 0;
  }
  const { files } = JSON.parse(readFileSync(pkgPath, "utf8"));
  if (!files || files.length === 0) {
    console.log("KB_SKIP=empty");
    return 0;
  }
  const treeInfo = listKbTree();
  const branch = `fleet/kb-${sha256(files.map((f) => f.path).join(",")).slice(0, 8)}`;
  ensureBranch(KB_REPO, branch, treeInfo.baseSha, process.env);
  for (const f of files) {
    putFileContent(KB_REPO, f.path, f.content, branch, `[fleet-kb] add ${f.path}`, process.env);
  }
  const body = [
    "## fleet-kb synthesis package",
    "",
    `**Files:** ${files.map((f) => "`" + f.path + "`").join(", ")}`,
    "",
    "_Autonomous OKF-compliant synthesis by the M1Vj fleet KB agent. All KB guardrails respected (.okf untouched, no raw/, frontmatter validated). Review before merging._",
  ].join("\n");
  let pr = findExistingOpenPr(KB_REPO, branch, process.env);
  if (!pr) {
    try {
      pr = ghInput(
        ["api", "-X", "POST", `/repos/${KB_REPO}/pulls`],
        { title: `[fleet-kb] synthesis package: ${files[0].path}`, body, head: branch, base: treeInfo.defaultBranch, draft: true },
        process.env,
      );
    } catch (err) {
      pr = findExistingOpenPr(KB_REPO, branch, process.env);
      if (!pr) throw err;
    }
  }
  await verifyPullAuthor(KB_REPO, pr.number, identity, process.env.FLEET_GH_TOKEN);
  const headSha = pr.head && pr.head.sha ? pr.head.sha : null;
  if (!headSha) throw new Error("PR head sha unavailable");
  await verifyCommit(KB_REPO, headSha, identity, process.env.FLEET_GH_TOKEN);
  audit.note("ship", `pr=#${pr.number} files=${files.length}`);

  const labDir = path.join(REPO_ROOT, "docs", "kb-lab");
  mkdirSync(labDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 16);
  writeFileSync(path.join(labDir, `${stamp}--package.md`),
    ["# KB synthesis package", `- PR: ${pr.html_url}`, `- files: ${files.map((f) => f.path).join(", ")}`, "", ...files.flatMap((f) => ["## " + f.path, "", f.content])].join("\n"));
  const labPaths = ["docs/kb-lab", "docs/gdrive-inbox"].filter((p2) => existsSync(path.join(REPO_ROOT, p2)));
  if (labPaths.length > 0 && gitHasChanges(REPO_ROOT, labPaths)) {
    gitAdd(REPO_ROOT, labPaths);
    gitCommit(REPO_ROOT, `[fleet] kb-lab mirror ${stamp} PR#${pr.number}`, identity);
    gitPush(REPO_ROOT, "main", process.env);
    const sha = gitRevParse(REPO_ROOT, "HEAD");
    await verifyCommit("M1Vj/fleet-control", sha, identity, process.env.FLEET_GH_TOKEN);
  }
  console.log(`FLEET_RUN_RESULT=${JSON.stringify({ mode: "ship", pr: pr.number, files: files.length })}`);
  return 0;
}

const MODES = { inventory: modeInventory, synthesize: modeSynthesize, ship: modeShip };

if (process.argv[1] && import.meta.url.endsWith(path.basename(process.argv[1]))) {
  const mode = process.env.FLEET_KB_MODE;
  const audit = new AuditBuffer(scrub(process.env));
  if (!mode || !MODES[mode]) {
    console.error("FLEET_KB_MODE must be one of inventory|synthesize|ship");
    process.exit(1);
  }
  try {
    const code = await MODES[mode](audit);
    audit.writeMarkdown(path.join(REPO_ROOT, "audit"), `kb-${mode}-${Date.now()}`, `KB ${mode}`, code === 0 ? "ok" : "failed");
    if (code !== 0) for (const e of [...audit.entries, ...audit.incidents]) console.log(`AUDIT ${JSON.stringify(e)}`);
    process.exit(code);
  } catch (err) {
    audit.incident("fatal", err.message);
    audit.writeMarkdown(path.join(REPO_ROOT, "audit"), `kb-${mode}-${Date.now()}`, `KB ${mode}`, `failed(${err.code || 1})`);
    console.error(`KB_FAILED mode=${mode} reason=${err.reason || err.message}`);
    for (const e of [...audit.entries, ...audit.incidents]) console.log(`AUDIT ${JSON.stringify(e)}`);
    process.exit(err.code && Number.isInteger(err.code) ? err.code : 1);
  }
}
