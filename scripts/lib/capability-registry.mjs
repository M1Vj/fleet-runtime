import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
  realpathSync,
} from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";

const HASH_RE = /^sha256:[a-f0-9]{64}$/;
const ID_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
const VERSION_RE = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/;
const MAX_REGISTRY_ITEMS = 256;
const MAX_SKILL_BYTES = 256 * 1024;
const MAX_TOOL_STEPS = 64;
const MAX_TOOL_ITEMS = 10_000;
const MAX_SERIALIZED_DATA = 1_000_000;
const MAX_TEXT_CHARS = 64 * 1024;

const SKILL_FIELDS = new Set([
  "id", "version", "path", "digest", "rollbackDigest", "status", "lanes", "purpose", "description",
  "provenance", "capabilities", "protectedPathExclusions", "tokenBounds", "fixtures", "judges", "canary",
]);
const TOOL_FIELDS = new Set([
  "id", "version", "digest", "rollbackDigest", "status", "kind", "operations", "purpose", "description",
  "provenance", "capabilities", "protectedPathExclusions", "tokenBounds", "fixtures", "judges", "canary",
]);
const SKILL_CAPABILITIES = new Set([
  "public-research", "hostile-evidence-normalization", "citation-extraction", "citation-verification", "text-only",
  "no-shell", "no-network", "no-env", "no-write",
]);
const TOOL_CAPABILITIES = new Set([
  "source-ranking", "bounded-text-extraction", "json-selection", "diff-classification", "templating", "result-aggregation",
  "no-shell", "no-network", "no-env", "no-write",
]);
const DECLARATIVE_OPERATIONS = new Set([
  "filter-eq", "filter-neq", "filter-in", "filter-present", "sort-number", "sort-text", "take", "select",
  "extract-text", "template", "aggregate", "classify-diff",
]);
const SECRET_PATTERNS = [
  /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/i,
  /\b(?:gh[pousr]_[A-Za-z0-9_]{10,}|github_pat_[A-Za-z0-9_]{10,})\b/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /\b(?:sk-[A-Za-z0-9_-]{20,}|xox[baprs]-[A-Za-z0-9-]{10,}|AIza[0-9A-Za-z_-]{20,})\b/,
  /\b(?:access_token|refresh_token|api[-_]?key|client_secret|password)\s*[=:]\s*["']?[A-Za-z0-9._~+\/%=-]{12,}/i,
];
const DANGEROUS_PATH_PARTS = new Set(["", ".", "..", "__proto__", "constructor", "prototype"]);
const JUDGE_ID_RE = /^[a-z][a-z0-9._:-]{2,95}$/i;
const PLACEHOLDER_JUDGE_IDS = new Set([
  "a", "b", "foo", "bar", "baz", "test", "placeholder", "unknown", "default", "none", "null",
  "judge", "judge1", "judge2", "judge-1", "judge-2", "judge-a", "judge-b", "reviewer", "reviewer-1", "reviewer-2",
]);

const DEFAULT_SKILL_REGISTRY_PATH = new URL("../../config/skills.json", import.meta.url);
const DEFAULT_TOOL_REGISTRY_PATH = new URL("../../config/tools.json", import.meta.url);

function isRecord(value) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value)
    && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null));
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (isRecord(value)) return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]));
  return value;
}

function safeString(value, max = 240) {
  return typeof value === "string" && value.length <= max && !/[\u0000-\u001f\u007f]/.test(value);
}

function pushError(errors, message) {
  if (errors.length < 50) errors.push(message);
}

function hasSecretLike(value) {
  let serialized;
  try {
    serialized = JSON.stringify(value);
  } catch {
    return true;
  }
  return SECRET_PATTERNS.some((pattern) => pattern.test(serialized));
}

function validateUnknownFields(item, allowed, errors, label) {
  for (const key of Object.keys(item)) {
    if (!allowed.has(key)) pushError(errors, `${label} contains undeclared field ${key}`);
  }
}

function validateDigest(value, errors, label, required = false) {
  if (value === undefined && !required) return;
  if (typeof value !== "string" || !HASH_RE.test(value)) pushError(errors, `${label} must be sha256:<64 lowercase hex>`);
}

function validateManifestCommon(item, errors, label, allowed) {
  if (!isRecord(item)) {
    pushError(errors, `${label} must be an object`);
    return false;
  }
  validateUnknownFields(item, allowed, errors, label);
  if (!ID_RE.test(String(item.id || ""))) pushError(errors, `${label}.id is invalid`);
  if (!VERSION_RE.test(String(item.version || ""))) pushError(errors, `${label}.version is invalid`);
  if (!["active", "inactive"].includes(item.status)) pushError(errors, `${label}.status must be active or inactive`);
  validateDigest(item.digest, errors, `${label}.digest`, true);
  validateDigest(item.rollbackDigest, errors, `${label}.rollbackDigest`);
  if (item.digest && item.rollbackDigest && item.digest === item.rollbackDigest) pushError(errors, `${label} digest and rollbackDigest must differ`);
  for (const field of ["purpose", "description"]) {
    if (item[field] !== undefined && !safeString(item[field], 500)) pushError(errors, `${label}.${field} must be bounded text`);
  }
  if (item.provenance !== undefined) {
    if (!isRecord(item.provenance)) pushError(errors, `${label}.provenance must be an object`);
    else {
      for (const field of ["source", "license", "author"]) {
        if (!safeString(item.provenance[field], 240)) pushError(errors, `${label}.provenance.${field} is required text`);
      }
    }
  }
  if (item.protectedPathExclusions !== undefined) {
    if (!Array.isArray(item.protectedPathExclusions) || item.protectedPathExclusions.length > 64) {
      pushError(errors, `${label}.protectedPathExclusions must be a bounded array`);
    } else {
      for (const entry of item.protectedPathExclusions) {
        if (!safeRelativePath(entry, { allowWildcards: true })) pushError(errors, `${label}.protectedPathExclusions contains unsafe path`);
      }
    }
  }
  if (item.tokenBounds !== undefined) {
    if (!isRecord(item.tokenBounds)) pushError(errors, `${label}.tokenBounds must be an object`);
    else {
      for (const field of ["maxInputChars", "maxOutputChars"]) {
        if (!Number.isSafeInteger(item.tokenBounds[field]) || item.tokenBounds[field] < 1 || item.tokenBounds[field] > MAX_SERIALIZED_DATA) {
          pushError(errors, `${label}.tokenBounds.${field} is invalid`);
        }
      }
    }
  }
  if (item.fixtures !== undefined) validateFixtureArray(item.fixtures, errors, `${label}.fixtures`);
  if (item.judges !== undefined) validateJudgeArray(item.judges, errors, `${label}.judges`);
  if (item.canary !== undefined && !validCanary(item.canary)) pushError(errors, `${label}.canary is invalid`);
  if (hasSecretLike(item)) pushError(errors, `${label} contains secret-like content`);
  return true;
}

function safeRelativePath(value, { allowWildcards = false } = {}) {
  if (typeof value !== "string" || value.length === 0 || value.length > 240 || value.startsWith("/") || value.includes("\\") || value.includes("\0")) return false;
  const parts = value.split("/");
  if (parts.some((part) => DANGEROUS_PATH_PARTS.has(part))) return false;
  if (!allowWildcards && /[*?\[\]]/.test(value)) return false;
  return true;
}

function validateFixtureArray(value, errors, label) {
  if (!Array.isArray(value) || value.length > 32) {
    pushError(errors, `${label} must be a bounded array`);
    return;
  }
  for (const [index, fixture] of value.entries()) {
    if (!isRecord(fixture)) pushError(errors, `${label}[${index}] must be an object`);
    else {
      if (fixture.id !== undefined && !ID_RE.test(String(fixture.id))) pushError(errors, `${label}[${index}].id is invalid`);
      if (JSON.stringify(fixture).length > 32 * 1024) pushError(errors, `${label}[${index}] is too large`);
      if (hasSecretLike(fixture)) pushError(errors, `${label}[${index}] contains secret-like content`);
    }
  }
}

function validateJudgeArray(value, errors, label) {
  if (!Array.isArray(value) || value.length > 8) {
    pushError(errors, `${label} must be a bounded array`);
    return;
  }
  const ids = new Set();
  for (const [index, judge] of value.entries()) {
    if (!isRecord(judge)) {
      pushError(errors, `${label}[${index}] must be an object`);
      continue;
    }
    const id = typeof judge.id === "string" ? judge.id.trim().toLowerCase() : "";
    if (!JUDGE_ID_RE.test(id) || PLACEHOLDER_JUDGE_IDS.has(id)) {
      pushError(errors, `${label}[${index}].id must be a named judge identity`);
    } else if (ids.has(id)) {
      pushError(errors, `${label} contains duplicate judge id ${id}`);
    } else {
      ids.add(id);
    }
    if (!["pass", "fail", "blocked"].includes(judge.verdict)) pushError(errors, `${label}[${index}].verdict is invalid`);
    if (judge.trusted !== undefined && typeof judge.trusted !== "boolean") pushError(errors, `${label}[${index}].trusted is invalid`);
    if (judge.candidateDigest !== undefined && !HASH_RE.test(String(judge.candidateDigest))) {
      pushError(errors, `${label}[${index}].candidateDigest is invalid`);
    }
    if (hasSecretLike(judge)) pushError(errors, `${label}[${index}] contains secret-like content`);
  }
}

function validCanary(value) {
  if (typeof value === "boolean") return true;
  return isRecord(value)
    && (value.status === undefined || ["passed", "failed", "blocked"].includes(value.status))
    && (value.digest === undefined || HASH_RE.test(String(value.digest)))
    && (value.rollbackDigest === undefined || HASH_RE.test(String(value.rollbackDigest)));
}

function validateCapabilities(value, allowed, errors, label) {
  if (value === undefined) return;
  if (!Array.isArray(value) || value.length === 0 || value.length > 32) {
    pushError(errors, `${label}.capabilities must be a bounded non-empty array`);
    return;
  }
  const seen = new Set();
  for (const capability of value) {
    if (typeof capability !== "string" || !allowed.has(capability)) pushError(errors, `${label} declares an unsupported capability`);
    if (seen.has(capability)) pushError(errors, `${label} declares duplicate capabilities`);
    seen.add(capability);
  }
}

function validateOperations(value, errors, label) {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_TOOL_STEPS) {
    pushError(errors, `${label}.operations must contain 1-${MAX_TOOL_STEPS} operations`);
    return;
  }
  for (const [index, operation] of value.entries()) {
    if (!isRecord(operation) || typeof operation.op !== "string" || !DECLARATIVE_OPERATIONS.has(operation.op)) {
      pushError(errors, `${label}.operations[${index}] uses an unsupported operation`);
      continue;
    }
    if (operation.op === "take" && (!Number.isSafeInteger(operation.count) || operation.count < 0 || operation.count > MAX_TOOL_ITEMS)) {
      pushError(errors, `${label}.operations[${index}].count is invalid`);
    }
    if (["filter-eq", "filter-neq", "filter-in", "filter-present", "sort-number", "sort-text", "extract-text"].includes(operation.op)
      && !safeField(operation.field)) pushError(errors, `${label}.operations[${index}].field is invalid`);
    if (operation.op === "select" && (!Array.isArray(operation.fields) || operation.fields.length === 0 || operation.fields.length > 64 || operation.fields.some((field) => !safeField(field)))) {
      pushError(errors, `${label}.operations[${index}].fields is invalid`);
    }
    if (["sort-number", "sort-text"].includes(operation.op) && !["asc", "desc"].includes(operation.direction || "asc")) {
      pushError(errors, `${label}.operations[${index}].direction is invalid`);
    }
    if (operation.op === "filter-in" && (!Array.isArray(operation.values) || operation.values.length > 256)) {
      pushError(errors, `${label}.operations[${index}].values is invalid`);
    }
    if (operation.op === "template" && (!safeString(operation.template, 2000) || !Array.isArray(operation.fields) || operation.fields.some((field) => !safeField(field)))) {
      pushError(errors, `${label}.operations[${index}] template is invalid`);
    }
    if (operation.op === "aggregate" && !["count", "sum", "min", "max"].includes(operation.mode)) {
      pushError(errors, `${label}.operations[${index}].mode is invalid`);
    }
    if (operation.op === "classify-diff" && operation.field !== undefined && !safeField(operation.field)) {
      pushError(errors, `${label}.operations[${index}].field is invalid`);
    }
    if (hasSecretLike(operation)) pushError(errors, `${label}.operations[${index}] contains secret-like content`);
  }
}

function safeField(value) {
  if (typeof value !== "string" || value.length === 0 || value.length > 160) return false;
  const parts = value.split(".");
  return parts.every((part) => /^[A-Za-z0-9_-]{1,64}$/.test(part) && !DANGEROUS_PATH_PARTS.has(part));
}

/** Validate a committed skill registry without reading or executing any skill. */
export function validateSkillRegistry(value) {
  const errors = [];
  if (!isRecord(value)) return { ok: false, errors: ["registry must be an object"] };
  validateUnknownFields(value, new Set(["version", "skills"]), errors, "registry");
  if (value.version !== 1) pushError(errors, "registry.version must be 1");
  if (!Array.isArray(value.skills) || value.skills.length === 0 || value.skills.length > MAX_REGISTRY_ITEMS) {
    pushError(errors, "registry.skills must be a bounded non-empty array");
  }
  const ids = new Set();
  for (const [index, skill] of (Array.isArray(value.skills) ? value.skills : []).entries()) {
    const label = `skill[${index}]`;
    if (!validateManifestCommon(skill, errors, label, SKILL_FIELDS)) continue;
    if (ids.has(skill.id)) pushError(errors, `duplicate skill id ${skill.id}`);
    ids.add(skill.id);
    if (!safeRelativePath(skill.path) || !String(skill.path).endsWith("SKILL.md")) pushError(errors, `${label}.path is unsafe`);
    if (!Array.isArray(skill.lanes) || skill.lanes.length === 0 || skill.lanes.length > 16 || skill.lanes.some((lane) => !/^[a-z][a-z0-9-]{0,31}$/.test(String(lane)))) {
      pushError(errors, `${label}.lanes is invalid`);
    }
    validateCapabilities(skill.capabilities, SKILL_CAPABILITIES, errors, label);
  }
  return { ok: errors.length === 0, errors };
}

/** Validate the declarative tool registry and reject executable capability types. */
export function validateToolRegistry(value) {
  const errors = [];
  if (!isRecord(value)) return { ok: false, errors: ["registry must be an object"] };
  validateUnknownFields(value, new Set(["version", "tools"]), errors, "registry");
  if (value.version !== 1) pushError(errors, "registry.version must be 1");
  if (!Array.isArray(value.tools) || value.tools.length === 0 || value.tools.length > MAX_REGISTRY_ITEMS) {
    pushError(errors, "registry.tools must be a bounded non-empty array");
  }
  const ids = new Set();
  for (const [index, tool] of (Array.isArray(value.tools) ? value.tools : []).entries()) {
    const label = `tool[${index}]`;
    if (!validateManifestCommon(tool, errors, label, TOOL_FIELDS)) continue;
    if (ids.has(tool.id)) pushError(errors, `duplicate tool id ${tool.id}`);
    ids.add(tool.id);
    if (tool.kind !== "declarative-v1") pushError(errors, `${label}.kind must be declarative-v1`);
    validateOperations(tool.operations, errors, label);
    validateCapabilities(tool.capabilities, TOOL_CAPABILITIES, errors, label);
  }
  return { ok: errors.length === 0, errors };
}

function readRegistry(filePath, validate, code) {
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(filePath, "utf8"));
  } catch {
    throw new Error(`${code}_INVALID`);
  }
  const result = validate(parsed);
  if (!result.ok) throw new Error(`${code}_INVALID: ${result.errors.join("; ")}`);
  return parsed;
}

export function loadSkillRegistry(filePath = DEFAULT_SKILL_REGISTRY_PATH) {
  return readRegistry(filePath, validateSkillRegistry, "SKILL_REGISTRY");
}

export function loadToolRegistry(filePath = DEFAULT_TOOL_REGISTRY_PATH) {
  return readRegistry(filePath, validateToolRegistry, "TOOL_REGISTRY");
}

function isWithin(child, parent) {
  const relative = path.relative(parent, child);
  return relative === "" || (relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative));
}

function readRegularBounded(filePath, root) {
  const rootReal = realpathSync(root);
  const candidate = path.resolve(rootReal, filePath);
  if (!isWithin(candidate, rootReal)) throw new Error("SKILL_PATH_OUTSIDE_ROOT");
  const stat = lstatSync(candidate);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("SKILL_FILE_UNSAFE");
  const real = realpathSync(candidate);
  if (!isWithin(real, rootReal)) throw new Error("SKILL_PATH_OUTSIDE_ROOT");
  let descriptor;
  try {
    descriptor = openSync(real, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
    const opened = fstatSync(descriptor);
    if (!opened.isFile() || opened.size > MAX_SKILL_BYTES) throw new Error("SKILL_TOO_LARGE");
    return readFileSync(descriptor, "utf8");
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

function frontMatterValue(text, key) {
  const match = String(text).match(new RegExp(`^${key}:\\s*(.+)$`, "mi"));
  return match ? match[1].trim().replace(/^['"]|['"]$/g, "") : "";
}

/** Load only an active, lane-compatible skill whose bytes match its registry digest. */
export function loadGovernedSkill({ root, registry, id, lane } = {}) {
  const checked = validateSkillRegistry(registry);
  if (!checked.ok) throw new Error(`SKILL_REGISTRY_INVALID: ${checked.errors.join("; ")}`);
  const skill = registry.skills.find((entry) => entry.id === id);
  if (!skill) throw new Error("SKILL_NOT_REGISTERED");
  if (skill.status !== "active") throw new Error("SKILL_NOT_ACTIVE");
  if (lane !== undefined && !skill.lanes.includes(lane) && !skill.lanes.includes("all")) throw new Error("SKILL_LANE_NOT_ALLOWED");
  if (typeof root !== "string" || !path.isAbsolute(root)) throw new Error("SKILL_ROOT_REQUIRED");
  const text = readRegularBounded(skill.path, root);
  const actual = `sha256:${createHash("sha256").update(text, "utf8").digest("hex")}`;
  if (actual !== skill.digest) throw new Error("SKILL_DIGEST_MISMATCH");
  if (hasSecretLike(text)) throw new Error("SKILL_SECRET_SCAN_FAILED");
  if (!/^---\r?\n/.test(text) || !/^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/.test(text)) throw new Error("SKILL_FRONTMATTER_INVALID");
  if (frontMatterValue(text, "name") !== skill.id) throw new Error("SKILL_NAME_MISMATCH");
  if (!frontMatterValue(text, "description")) throw new Error("SKILL_DESCRIPTION_REQUIRED");
  return {
    id: skill.id,
    version: skill.version,
    path: skill.path,
    digest: skill.digest,
    lanes: [...skill.lanes],
    text,
  };
}

/** Load only an active declarative tool whose manifest matches its registry digest. */
export function loadGovernedTool({ registry, id } = {}) {
  const checked = validateToolRegistry(registry);
  if (!checked.ok) throw new Error(`TOOL_REGISTRY_INVALID: ${checked.errors.join("; ")}`);
  const tool = registry.tools.find((entry) => entry.id === id);
  if (!tool) throw new Error("TOOL_NOT_REGISTERED");
  if (tool.status !== "active") throw new Error("TOOL_NOT_ACTIVE");
  const actual = capabilityDigest(tool);
  if (actual !== tool.digest) throw new Error("TOOL_DIGEST_MISMATCH");
  return cloneData(tool);
}

function cloneData(value, depth = 0) {
  if (depth > 20) throw new Error("tool input exceeds depth bound");
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (Array.isArray(value)) {
    if (value.length > MAX_TOOL_ITEMS) throw new Error("tool input exceeds item bound");
    const result = value.map((entry) => cloneData(entry, depth + 1));
    if (JSON.stringify(result).length > MAX_SERIALIZED_DATA) throw new Error("tool data exceeds size bound");
    return result;
  }
  if (!isRecord(value)) throw new Error("tool data must be JSON objects or arrays");
  const result = {};
  for (const [key, entry] of Object.entries(value)) {
    if (!safeField(key)) throw new Error("tool data contains an unsafe field");
    result[key] = cloneData(entry, depth + 1);
  }
  if (JSON.stringify(result).length > MAX_SERIALIZED_DATA) throw new Error("tool data exceeds size bound");
  return result;
}

function deepEqual(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function fieldValue(value, field) {
  if (!safeField(field) || !isRecord(value)) return undefined;
  let current = value;
  for (const part of field.split(".")) {
    if (!isRecord(current) || !Object.prototype.hasOwnProperty.call(current, part)) return undefined;
    current = current[part];
  }
  return current;
}

function requireRows(state, op) {
  if (!Array.isArray(state)) throw new Error(`${op} requires an array`);
  return state;
}

function executeOperation(state, operation) {
  const op = operation.op;
  switch (op) {
    case "filter-eq":
      return requireRows(state, op).filter((row) => deepEqual(fieldValue(row, operation.field), operation.value));
    case "filter-neq":
      return requireRows(state, op).filter((row) => !deepEqual(fieldValue(row, operation.field), operation.value));
    case "filter-in":
      return requireRows(state, op).filter((row) => operation.values.some((value) => deepEqual(fieldValue(row, operation.field), value)));
    case "filter-present":
      return requireRows(state, op).filter((row) => fieldValue(row, operation.field) !== undefined);
    case "sort-number": {
      const direction = operation.direction === "desc" ? -1 : 1;
      return requireRows(state, op).map((row, index) => ({ row, index, value: Number(fieldValue(row, operation.field)) }))
        .sort((left, right) => {
          const lNaN = !Number.isFinite(left.value);
          const rNaN = !Number.isFinite(right.value);
          if (lNaN && rNaN) return left.index - right.index;
          if (lNaN) return 1;
          if (rNaN) return -1;
          return ((left.value - right.value) * direction) || (left.index - right.index);
        }).map(({ row }) => row);
    }
    case "sort-text": {
      const direction = operation.direction === "desc" ? -1 : 1;
      return requireRows(state, op).map((row, index) => ({ row, index, value: String(fieldValue(row, operation.field) ?? "") }))
        .sort((left, right) => (left.value.localeCompare(right.value) * direction) || (left.index - right.index))
        .map(({ row }) => row);
    }
    case "take":
      return requireRows(state, op).slice(0, operation.count);
    case "select":
      return requireRows(state, op).map((row) => {
        const selected = {};
        for (const field of operation.fields) {
          const value = fieldValue(row, field);
          if (value !== undefined) selected[field] = value;
        }
        return selected;
      });
    case "extract-text":
      return requireRows(state, op).map((row) => String(fieldValue(row, operation.field) ?? "").slice(0, MAX_TEXT_CHARS));
    case "template":
      return requireRows(state, op).map((row) => operation.template.replace(/\{\{([A-Za-z0-9_.-]+)\}\}/g, (match, field) => {
        if (!operation.fields.includes(field)) return "";
        return String(fieldValue(row, field) ?? "").slice(0, 1000);
      }).slice(0, MAX_TEXT_CHARS));
    case "aggregate": {
      const rows = requireRows(state, op);
      if (operation.mode === "count") return rows.length;
      const values = rows.map((row) => Number(fieldValue(row, operation.field))).filter(Number.isFinite);
      if (values.length === 0) return null;
      if (operation.mode === "sum") return values.reduce((sum, value) => sum + value, 0);
      return operation.mode === "min" ? Math.min(...values) : Math.max(...values);
    }
    case "classify-diff": {
      const rows = requireRows(state, op);
      return rows.map((row) => {
        const text = operation.field ? String(fieldValue(row, operation.field) ?? "") : JSON.stringify(row);
        const lower = text.toLowerCase();
        const classification = /(?:private key|api[_ -]?key|token|secret|password)/i.test(text)
          ? "sensitive"
          : lower.includes("delete") || lower.includes("remove") ? "deletion"
            : lower.includes("add") || lower.includes("create") ? "addition" : "change";
        return { ...row, classification };
      });
    }
    default:
      throw new Error(`unsupported operation: ${String(op)}`);
  }
}

/** Execute only the bounded declarative language; no shell, network, env, imports, or writes exist here. */
export function executeDeclarativeTool(tool, input) {
  if (!isRecord(tool) || tool.kind !== "declarative-v1") throw new Error("unsupported operation: tool kind");
  const operationErrors = [];
  validateOperations(tool.operations, operationErrors, "tool");
  if (operationErrors.length > 0) throw new Error(operationErrors.join("; "));
  let state = cloneData(input);
  for (const operation of tool.operations) {
    state = executeOperation(state, operation);
    state = cloneData(state);
  }
  return state;
}

function gateBoolean(candidate, field, reasons, reason) {
  if (candidate[field] !== true) reasons.push(reason);
}

function namedJudgeId(value) {
  const id = typeof value === "string" ? value.trim().toLowerCase() : "";
  return JUDGE_ID_RE.test(id) && !PLACEHOLDER_JUDGE_IDS.has(id) ? id : "";
}

function candidateDigest(value) {
  const digest = typeof value === "string" ? value.trim().toLowerCase() : "";
  return HASH_RE.test(digest) ? digest : "";
}

function fixturePassed(fixture, digest) {
  if (!isRecord(fixture)) return false;
  const status = String(fixture.status || fixture.verdict || "").trim().toLowerCase();
  const passed = fixture.passed === true || fixture.ok === true || status === "passed" || status === "pass";
  if (!passed) return false;
  // A fixture must carry an observed/result value. A bare `passed: true` is
  // indistinguishable from a placeholder and cannot authorize promotion.
  const hasResult = ["result", "observed", "actual", "output", "evidence"].some((key) => {
    if (!Object.prototype.hasOwnProperty.call(fixture, key)) return false;
    const value = fixture[key];
    return value !== undefined && value !== null && (typeof value !== "string" || value.trim().length > 0);
  });
  if (!hasResult) return false;
  const fixtureDigest = fixture.candidateDigest || fixture.digest || fixture.inputDigest;
  return fixtureDigest === undefined || fixtureDigest === digest;
}

function syntheticCanaryPassed(value, digest) {
  if (!isRecord(value)) return false;
  const status = String(value.status || value.verdict || "").trim().toLowerCase();
  const passed = value.passed === true || value.ok === true || status === "passed" || status === "pass";
  if (!passed) return false;
  const canaryDigest = value.candidateDigest || value.digest || value.inputDigest;
  // The canary must name the exact candidate digest. This prevents a generic
  // health ping from being reused as evidence for a different artifact.
  if (canaryDigest !== digest) return false;
  if (value.synthetic === false) return false;
  return true;
}

function priorDigestMatches(candidate, digest, options = {}) {
  const declared = candidate.priorActiveDigest || candidate.previousActiveDigest
    || candidate.rollback?.digest || options.priorActiveDigest;
  if (declared !== digest) return false;
  if (candidate.rollbackVerified === true || candidate.rollbackAvailable === true || options.rollbackVerified === true) return true;
  const registry = options.registry || candidate.registry;
  if (!isRecord(registry)) return false;
  const entries = Array.isArray(registry.skills) ? registry.skills : Array.isArray(registry.tools) ? registry.tools : [];
  const id = candidate.id || candidate.manifest?.id;
  // A committed inactive entry is a valid rollback seed. It is deliberately
  // digest-pinned and still cannot load at runtime until the candidate passes
  // every promotion gate and the registry pointer becomes active.
  return entries.some((entry) => isRecord(entry)
    && entry.id === id
    && ["active", "inactive"].includes(entry.status)
    && entry.digest === digest);
}

/** Evaluate only the gates that permit safe text/declarative capability activation. */
export function evaluateCapabilityCandidate(candidate = {}, options = {}) {
  const reasons = [];
  const autoKind = candidate.kind === "skill" || candidate.kind === "declarative-v1";
  if (!autoKind) reasons.push("kind-not-auto-activatable");
  if (autoKind) {
    gateBoolean(candidate, "protectedPathSafe", reasons, "protected-path-gate-failed");
    gateBoolean(candidate, "secretScanPassed", reasons, "secret-scan-gate-failed");
    gateBoolean(candidate, "schemaPassed", reasons, "schema-gate-failed");
    const fixtures = Array.isArray(candidate.fixtureResults)
      ? candidate.fixtureResults
      : Array.isArray(candidate.fixtures) ? candidate.fixtures : [];
    const digest = candidateDigest(candidate.digest || candidate.candidateDigest);
    if (fixtures.length === 0 || !fixtures.every((fixture) => fixturePassed(fixture, digest))) {
      reasons.push("fixture-gate-failed");
    }
    if (!syntheticCanaryPassed(candidate.canaryResult || candidate.canary, digest)) {
      reasons.push("canary-gate-failed");
    }
  }
  const judges = Array.isArray(candidate.judgeResults)
    ? candidate.judgeResults
    : Array.isArray(candidate.judges) ? candidate.judges : [];
  const trustedJudgeIds = new Set(
    (Array.isArray(candidate.trustedJudgeIds) ? candidate.trustedJudgeIds : options.trustedJudgeIds || [])
      .map(namedJudgeId)
      .filter(Boolean),
  );
  if (autoKind && judges.length < 2) reasons.push("two-independent-judges-required");
  if (autoKind && judges.length >= 2) {
    const ids = judges.map((judge) => namedJudgeId(judge?.id));
    if (ids.some((id) => !id) || new Set(ids).size !== ids.length) reasons.push("judges-must-be-independent");
    if (judges.some((judge, index) => !isRecord(judge)
      || judge.verdict !== "pass"
      || (judge.trusted !== true && !trustedJudgeIds.has(ids[index]))
      || (judge.candidateDigest !== undefined && judge.candidateDigest !== candidateDigest(candidate.digest || candidate.candidateDigest)))) {
      reasons.push("judge-gate-failed");
    }
  }
  if (autoKind && judges.length >= 2 && trustedJudgeIds.size === 0
    && judges.some((judge) => judge?.trusted !== true)) {
    reasons.push("trusted-judges-required");
  }
  if (autoKind && !candidateDigest(candidate.digest || candidate.candidateDigest)) reasons.push("candidate-digest-invalid");
  const rollbackDigest = candidateDigest(candidate.rollbackDigest);
  if (autoKind && !rollbackDigest) reasons.push("rollback-digest-invalid");
  if (autoKind && rollbackDigest && candidateDigest(candidate.digest || candidate.candidateDigest) === rollbackDigest) {
    reasons.push("rollback-digest-must-differ");
  }
  if (autoKind && rollbackDigest && !priorDigestMatches(candidate, rollbackDigest, options)) {
    reasons.push("prior-active-rollback-required");
  }
  if (reasons.length === 0) return { activate: true, disposition: "auto-activate", reasons: [] };
  const ownerReview = reasons.includes("kind-not-auto-activatable") || reasons.includes("protected-path-gate-failed");
  return {
    activate: false,
    disposition: ownerReview ? "owner-review" : "blocked",
    reasons: [...new Set(reasons)],
  };
}

/** Stable manifest digest helper for tooling and fixture generation. */
export function capabilityDigest(value) {
  const copy = isRecord(value) ? { ...value } : value;
  if (isRecord(copy)) {
    delete copy.digest;
    delete copy.rollbackDigest;
  }
  return `sha256:${createHash("sha256").update(JSON.stringify(canonicalize(copy)), "utf8").digest("hex")}`;
}

export { DECLARATIVE_OPERATIONS, HASH_RE };
