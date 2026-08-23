const SECRET_PATTERNS = [
  /(ghp|gho|ghs|ghu|ghr)_[A-Za-z0-9_]{10,}/,
  /github_pat_[A-Za-z0-9_]{10,}/,
  /AKIA[0-9A-Z]{16}/,
  /BEGIN [A-Z ]*PRIVATE KEY/,
  /sk-[A-Za-z0-9]{20,}/,
  /xox[baprs]-[A-Za-z0-9-]{10,}/,
  /AIza[0-9A-Za-z_-]{20,}/,
];

function containsSecret(s) {
  return SECRET_PATTERNS.some((re) => re.test(String(s)));
}

const KINDS = new Set(["fleet_issue", "report", "comment", "label", "draft_pr", "noop"]);
const REPORT_SECTIONS = new Set(["triage", "security", "standards", "docs", "testing", "redteam"]);
const BRANCH_RE = /^fleet\/[a-z0-9][a-z0-9-]{4,60}$/;

export function isSafeRepoPath(p) {
  if (typeof p !== "string" || p.length === 0 || p.length > 200) return false;
  if (p.includes("..") || p.startsWith("/") || p.includes("\\")) return false;
  const segments = p.split("/");
  if (segments.some((s) => s === "" || s === ".")) return false;
  const lower = p.toLowerCase();
  if (lower.endsWith(".pem") || lower.endsWith(".key")) return false;
  if (/(^|\/)\.env/.test(lower)) return false;
  if (lower.startsWith("state/") || lower.startsWith("audit/")) return false;
  if (lower.includes("id_rsa") || lower.includes("credential")) return false;
  return true;
}

function checkSize(value, max, label, errors) {
  if (String(value).length > max) errors.push(`${label} exceeds ${max} chars`);
  if (containsSecret(value)) errors.push(`${label} contains secret-like content`);
}

export function sanitizeControlChars(text) {
  let out = "";
  let inString = false;
  let escaped = false;
  for (const ch of String(text)) {
    const code = ch.charCodeAt(0);
    if (escaped) {
      out += ch;
      escaped = false;
      continue;
    }
    if (inString && ch === "\\") {
      out += ch;
      escaped = true;
      continue;
    }
    if (ch === '"') {
      inString = !inString;
      out += ch;
      continue;
    }
    if (inString && code < 0x20) {
      if (ch === "\n") out += "\\n";
      else if (ch === "\r") out += "\\r";
      else if (ch === "\t") out += "\\t";
      else out += "\\u" + code.toString(16).padStart(4, "0");
      continue;
    }
    out += ch;
  }
  return out;
}

export function stripFences(raw) {
  const trimmed = String(raw).trim();
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/);
  return fenced ? fenced[1].trim() : trimmed;
}

export function extractJsonArray(raw) {
  const text = String(raw);
  const candidates = [stripFences(text)];
  const start = text.indexOf("[");
  const end = text.lastIndexOf("]");
  if (start !== -1 && end > start) candidates.push(text.slice(start, end + 1));
  candidates.push(sanitizeControlChars(stripFences(text)));
  if (start !== -1 && end > start) candidates.push(sanitizeControlChars(text.slice(start, end + 1)));
  for (const candidate of candidates) {
    try {
      return JSON.parse(candidate);
    } catch {
      continue;
    }
  }
  throw new Error("unparseable JSON array");
}

export function validateDirectives(rawString) {
  const errors = [];
  let parsed;
  try {
    parsed = extractJsonArray(rawString);
  } catch (err) {
    return { ok: false, directives: [], errors: [`unparseable JSON: ${err.message}`] };
  }
  if (!Array.isArray(parsed)) {
    return { ok: false, directives: [], errors: ["payload must be a JSON array"] };
  }
  if (parsed.length > 25) {
    return { ok: false, directives: [], errors: [`too many directives (${parsed.length} > 25)`] };
  }
  const directives = [];
  parsed.forEach((d, i) => {
    const tag = `directive[${i}]`;
    if (!d || typeof d !== "object" || Array.isArray(d)) {
      errors.push(`${tag} not an object`);
      return;
    }
    if (!KINDS.has(d.kind)) {
      errors.push(`${tag} unknown kind ${JSON.stringify(d.kind)}`);
      return;
    }
    for (const [k, v] of Object.entries(d)) {
      if (typeof v === "string" && containsSecret(v)) {
        errors.push(`${tag}.${k} contains secret-like content`);
        return;
      }
    }
    switch (d.kind) {
      case "fleet_issue":
        checkSize(d.title, 120, `${tag}.title`, errors);
        checkSize(d.body, 8000, `${tag}.body`, errors);
        break;
      case "report":
        if (!REPORT_SECTIONS.has(d.section)) {
          errors.push(`${tag}.section invalid`);
          return;
        }
        checkSize(d.text, 4000, `${tag}.text`, errors);
        break;
      case "comment":
        if (!["issue", "pr"].includes(d.target)) { errors.push(`${tag}.target invalid`); return; }
        if (!Number.isInteger(d.number) || d.number <= 0) { errors.push(`${tag}.number invalid`); return; }
        if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(String(d.repo))) { errors.push(`${tag}.repo invalid`); return; }
        checkSize(d.body, 2000, `${tag}.body`, errors);
        break;
      case "label":
        if (!Array.isArray(d.labels) || d.labels.length === 0 || d.labels.length > 5) { errors.push(`${tag}.labels invalid`); return; }
        if (!Number.isInteger(d.number) || d.number <= 0) { errors.push(`${tag}.number invalid`); return; }
        if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(String(d.repo))) { errors.push(`${tag}.repo invalid`); return; }
        break;
      case "draft_pr": {
        if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(String(d.repo))) { errors.push(`${tag}.repo invalid`); return; }
        if (!BRANCH_RE.test(String(d.branch))) { errors.push(`${tag}.branch invalid`); return; }
        checkSize(d.title, 120, `${tag}.title`, errors);
        checkSize(d.body, 6000, `${tag}.body`, errors);
        if (!Array.isArray(d.files) || d.files.length === 0 || d.files.length > 10) {
          errors.push(`${tag}.files invalid`);
          return;
        }
        for (const f of d.files) {
          if (!f || typeof f !== "object" || typeof f.path !== "string") {
            errors.push(`${tag}.file invalid entry`);
            return;
          }
          if (!isSafeRepoPath(f.path)) {
            errors.push(`${tag}.file path rejected: ${f.path}`);
            return;
          }
          checkSize(f.content, 20000, `${tag}.file ${f.path}`, errors);
        }
        break;
      }
      case "noop":
        checkSize(d.reason, 500, `${tag}.reason`, errors);
        break;
      default:
        errors.push(`${tag} unhandled`);
        return;
    }
    directives.push(d);
  });
  if (errors.length > 0) return { ok: false, directives: [], errors };
  return { ok: true, directives, errors };
}
