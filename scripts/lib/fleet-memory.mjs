/**
 * Fleet persistent memory: pure helpers for bounded per-repo and universal
 * memory pages stored under FLEET_STATE_ROOT/state/memory/. No gh, no spawn,
 * no filesystem access here — callers own reading/writing so every function
 * stays deterministic and unit-testable.
 *
 * Page format (both repo pages and UNIVERSAL.md):
 *   H1 title line, one short purpose line, then reverse-chronological entries
 *   `- YYYY-MM-DDTHH:MMZ [lane] summary`, optionally a trailing "## Patterns"
 *   section. Writers enforce hard bounds: entry-count caps, a total-length
 *   cap that drops the OLDEST overflow, and per-summary clamping/scrubbing.
 */

export const MEMORY_ENTRY_LIMIT_REPO = 40;
export const MEMORY_ENTRY_LIMIT_UNIVERSAL = 60;
export const MEMORY_TOTAL_CHAR_CAP = 32768;
export const MEMORY_SUMMARY_MAX_CHARS = 240;
export const MEMORY_PATTERNS_HEADING = "## Patterns";
export const MEMORY_PROMPT_BLOCK_LABEL = "FLEET MEMORY (untrusted operational notes; verify against current evidence):";
export const UNIVERSAL_MEMORY_FILE_NAME = "UNIVERSAL.md";

const REPO_SHAPE_RE = /^[\w.-]+\/[\w.-]+$/;

/** Absolute path helper (pure): FLEET_STATE_ROOT/state/memory/repos/<owner>__<name>.md */
export function repoMemoryFilePath(stateRoot, repo) {
  const root = String(stateRoot ?? "");
  if (!root || !root.startsWith("/")) throw new Error("absolute FLEET_STATE_ROOT required for memory paths");
  return `${root.replace(/\/+$/, "")}/state/memory/repos/${memoryFileName(repo)}`;
}

/** Absolute path helper (pure): FLEET_STATE_ROOT/state/memory/UNIVERSAL.md */
export function universalMemoryFilePath(stateRoot) {
  const root = String(stateRoot ?? "");
  if (!root || !root.startsWith("/")) throw new Error("absolute FLEET_STATE_ROOT required for memory paths");
  return `${root.replace(/\/+$/, "")}/state/memory/${UNIVERSAL_MEMORY_FILE_NAME}`;
}

// Line-level secret patterns, styled after the merge-security test fixtures.
// A summary line matching any of these is dropped entirely before storage.
const SECRET_LINE_PATTERNS = [
  /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/,
  /\bBEGIN [A-Z0-9 ]*PRIVATE KEY\b/i,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/,
  /\bBearer\s+[A-Za-z0-9._~+/-]{16,}\b/i,
  /[?&#](?:access_token|refresh_token|id_token|token|api[-_]?key|apikey|client_secret|secret|password|passwd)=[A-Za-z0-9._~+/%=-]{1,}/i,
  /\b(?:access_token|refresh_token|id_token|token|api[-_]?key|apikey|client_secret|secret|password|passwd)\s*[:=]\s*["']?[A-Za-z0-9._~+/%=-]{12,}["']?/i,
  /gh[pousr]_[A-Za-z0-9_]{10,}/,
  /github_pat_[A-Za-z0-9_]{10,}/,
  /AKIA[0-9A-Z]{16}/,
  /sk-[A-Za-z0-9_-]{20,}/,
  /xox[baprs]-[A-Za-z0-9-]{10,}/,
  /AIza[0-9A-Za-z_-]{20,}/,
];

/** Deterministic `<owner>__<name>.md` page filename; rejects malformed or traversal-shaped repos. */
export function memoryFileName(repo) {
  const value = String(repo ?? "").trim();
  if (!REPO_SHAPE_RE.test(value)) throw new Error(`invalid repository shape: ${(value || "(empty)").slice(0, 80)}`);
  const [owner, name] = value.split("/");
  if (!owner || !name || owner === "." || owner === ".." || name === "." || name === "..") {
    throw new Error(`invalid repository path segment: ${value.slice(0, 80)}`);
  }
  return `${owner}__${name}.md`;
}

function sanitizeSingleLine(value) {
  return String(value ?? "")
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, "")
    .replace(/[\r\n]+/g, " ")
    .trim();
}

function containsSecretLike(text) {
  return SECRET_LINE_PATTERNS.some((pattern) => pattern.test(String(text ?? "")));
}

function clampSummary(value, max = MEMORY_SUMMARY_MAX_CHARS) {
  let out = "";
  for (const rawLine of String(value ?? "").split(/\r?\n/)) {
    const line = sanitizeSingleLine(rawLine);
    if (!line || containsSecretLike(line)) continue;
    const candidate = out ? `${out} ${line}` : line;
    out = candidate.slice(0, max);
    if (out.length >= max) break;
  }
  return out.slice(0, max);
}

function normalizeStamp(stampUtc) {
  const value = String(stampUtc ?? "").trim();
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}Z$/.test(value)) return value;
  const parsed = Date.parse(value);
  if (Number.isFinite(parsed)) return `${new Date(parsed).toISOString().slice(0, 16)}Z`;
  return `${new Date().toISOString().slice(0, 16)}Z`;
}

function buildEntryLine({ stampUtc, lane, summary } = {}) {
  const safeLane = sanitizeSingleLine(lane || "lane").slice(0, 32) || "lane";
  return `- ${normalizeStamp(stampUtc)} [${safeLane}] ${clampSummary(summary)}`;
}

/** Template rendered when a repo page does not exist yet. */
export function renderRepoMemoryPage(repo, { title, description } = {}) {
  const safeRepo = sanitizeSingleLine(repo).slice(0, 120);
  const heading = `# Fleet Memory — ${sanitizeSingleLine(title).slice(0, 120) || safeRepo}`;
  const purpose = description
    ? sanitizeSingleLine(description).slice(0, 240)
    : `Per-repo operational memory for \`${safeRepo}\`. Newest first; oldest entries drop beyond the retention bound.`;
  return `${heading}\n\n${purpose}\n`;
}

function splitPatternsSection(pageMd) {
  const text = String(pageMd ?? "");
  const idx = text.indexOf(MEMORY_PATTERNS_HEADING);
  return idx === -1
    ? { head: text, tail: "" }
    : { head: text.slice(0, idx), tail: text.slice(idx) };
}

function parseHead(head) {
  const lines = String(head ?? "").split("\n");
  // Headerless page (starts directly with an entry) → everything is entries.
  if (lines.length > 0 && lines[0].startsWith("- ")) {
    return { prefixLines: [], entryLines: lines.filter((line) => line.startsWith("- ")) };
  }
  // Purpose = first non-empty, non-entry line after the H1; entries never precede it.
  let purposeIdx = -1;
  for (let i = 1; i < lines.length; i += 1) {
    const line = lines[i];
    if (line.startsWith("- ")) break;
    if (line.trim() !== "") {
      purposeIdx = i;
      break;
    }
  }
  const prefixEnd = purposeIdx === -1 ? Math.min(lines.length, 1) : purposeIdx + 1;
  return {
    prefixLines: lines.slice(0, prefixEnd),
    entryLines: lines.slice(prefixEnd).filter((line) => line.startsWith("- ")),
  };
}

function composePage(prefixLines, entries, tail) {
  const headText = prefixLines.join("\n").replace(/\s*$/, "");
  const body = entries.length > 0 ? `${headText}\n\n${entries.join("\n")}` : headText;
  return `${body}\n${tail.endsWith("\n") || tail === "" ? tail : `${tail}\n`}`;
}

function boundPage(prefixLines, entries, tail, entryLimit) {
  // entries are newest-first: keep the newest N, drop oldest overflow
  let kept = entries.slice(0, entryLimit);
  let page = composePage(prefixLines, kept, tail);
  while (page.length > MEMORY_TOTAL_CHAR_CAP && kept.length > 0) {
    kept = kept.slice(0, -1); // truncate oldest overflow
    page = composePage(prefixLines, kept, tail);
  }
  return page;
}

/**
 * Insert one entry after the purpose line of a repo page (newest first).
 * Hard bounds: at most MEMORY_ENTRY_LIMIT_REPO entries, total length capped
 * at MEMORY_TOTAL_CHAR_CAP by dropping oldest overflow; the summary is
 * clamped to MEMORY_SUMMARY_MAX_CHARS with secret-like lines scrubbed.
 */
export function appendMemoryEntry(existingMd, { stampUtc, lane, repo, summary } = {}) {
  void repo; // accepted for call-site symmetry; pages follow the fixed `- stamp [lane] summary` format
  const entry = buildEntryLine({ stampUtc, lane, summary });
  const { head, tail } = splitPatternsSection(existingMd);
  const { prefixLines, entryLines } = parseHead(head);
  return boundPage(prefixLines, [entry, ...entryLines], tail, MEMORY_ENTRY_LIMIT_REPO);
}

/** Same bounds as appendMemoryEntry but with the universal 60-entry cap. */
export function appendUniversalEntry(existingMd, entry = {}) {
  const line = buildEntryLine(entry);
  const base = String(existingMd ?? "").trim() === ""
    ? renderRepoMemoryPage("fleet", {
      title: "Universal Fleet Memory",
      description: "Fleet-wide operational learnings shared across lanes and repositories.",
    })
    : existingMd;
  const { head, tail } = splitPatternsSection(base);
  const { prefixLines, entryLines } = parseHead(head);
  return boundPage(prefixLines, [line, ...entryLines], tail, MEMORY_ENTRY_LIMIT_UNIVERSAL);
}

function normalizeReasonClass(reason) {
  let text = sanitizeSingleLine(reason);
  const colon = text.indexOf(":");
  if (colon !== -1) text = text.slice(0, colon);
  return text
    .replace(/\b[0-9a-f]{7,40}\b/gi, " ")
    .replace(/\d+/g, " ")
    .replace(/[^\w\s/-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase()
    .slice(0, 120);
}

/** Pure aggregation over {lane,state,reason,repo} events → deterministic "## Patterns" markdown section. */
export function consolidatePatterns(events) {
  const list = Array.isArray(events) ? events.filter((event) => event && typeof event === "object") : [];
  const counts = new Map();
  for (const event of list) {
    const cls = normalizeReasonClass(event.reason || event.why || event.summary || event.state || "");
    const key = cls || "unclassified";
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  const ranked = [...counts.entries()]
    .sort((a, b) => (b[1] - a[1]) || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    .slice(0, 10);
  return [
    MEMORY_PATTERNS_HEADING,
    "",
    "Top recurring reason classes (normalized; digits and sha-like tokens stripped):",
    ...ranked.map(([cls, count], index) => `${index + 1}. ${cls}: ${count}`),
    "",
    `Total events analyzed: ${list.length}`,
    `Unique reason classes: ${counts.size}`,
    "",
  ].join("\n");
}

/** First maxChars chars ending at an entry boundary (never mid-line), with a truncation marker when cut. */
export function memoryExcerpt(md, maxChars = 1200) {
  const text = String(md ?? "").replace(/\u0000/g, "");
  const limit = Math.max(1, Number(maxChars) || 1200);
  if (text.length <= limit) return text;
  const slice = text.slice(0, limit);
  const lastNewline = slice.lastIndexOf("\n");
  const out = (lastNewline > 0 ? slice.slice(0, lastNewline) : "").replace(/\s+$/, "");
  return out === "" ? "(truncated)" : `${out}\n(truncated)`;
}

/** Exact untrusted prompt block used by all model-facing readers. */
export function formatMemoryPromptBlock(excerptMd, maxChars = 1200) {
  return `${MEMORY_PROMPT_BLOCK_LABEL}\n${memoryExcerpt(excerptMd, maxChars)}\n---\n`;
}

function stripSecretLines(text) {
  return String(text ?? "")
    .split("\n")
    .filter((line) => !containsSecretLike(line))
    .join("\n");
}

const ENTRY_LINE_RE = /^- \d{4}-\d{2}-\d{2}T\d{2}:\d{2}Z /;

function extractEntryLines(pageMd, maxEntries) {
  const { head } = splitPatternsSection(String(pageMd ?? ""));
  return parseHead(head).entryLines.filter((line) => ENTRY_LINE_RE.test(line)).slice(0, maxEntries);
}

function repoIsPrivate(pageMd) {
  return /^\[private\]/m.test(splitPatternsSection(String(pageMd ?? "")).head);
}

/**
 * Build the OKF digest published to the personal knowledge base:
 * frontmatter + last 30 universal entries + one-line per-repo status list.
 * Secret-pattern lines are stripped and `[private]` repos are excluded.
 */
export function buildMemoryDigest({ universalMd, repoPages = [], timestampUtc = new Date().toISOString(), maxUniversalEntries = 30 } = {}) {
  const stamp = Number.isFinite(Date.parse(String(timestampUtc ?? ""))) ? String(timestampUtc) : new Date().toISOString();
  const universalLines = extractEntryLines(universalMd, Math.max(0, Number(maxUniversalEntries) || 30))
    .map(stripSecretLines)
    .filter(Boolean)
    .map(sanitizeSingleLine);
  const repoLines = (Array.isArray(repoPages) ? repoPages : [])
    .filter((page) => page && typeof page.file === "string" && typeof page.md !== "undefined")
    .filter((page) => !repoIsPrivate(page.md))
    .map((page) => {
      const latestRaw = extractEntryLines(page.md, 1)[0] || "(no entries yet)";
      const latest = sanitizeSingleLine(stripSecretLines(latestRaw)).slice(0, 240) || "(latest entry redacted)";
      const file = sanitizeSingleLine(page.file).replace(/[^\w.-]/g, "").slice(0, 160);
      return `- ${file}: ${latest}`;
    })
    .filter(Boolean);
  return [
    "---",
    "type: Documentation",
    "title: Fleet Operational Memory Digest",
    "description: Distilled operational memory from the M1Vj autonomous fleet lanes (universal learnings plus per-repo status). Untrusted operational notes, auto-generated.",
    "tags: [fleet, memory, operations]",
    `timestamp: ${stamp}`,
    "---",
    "",
    "# Fleet Operational Memory Digest",
    "",
    "Auto-generated distilled view of the fleet's private operational memory. Entries are bounded and redacted; verify against live evidence before relying on them.",
    "",
    "## Universal entries",
    "",
    ...(universalLines.length > 0 ? universalLines : ["(no universal entries yet)"]),
    "",
    "## Per-repo status",
    "",
    ...(repoLines.length > 0 ? repoLines : ["(no repository pages yet)"]),
    "",
  ].join("\n");
}
