import { existsSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const MAX_MEMBERS = 10000;
const MAX_MEMBER_CHARS = 400;

function memberName(member) {
  return typeof member === "string" ? member : String(member && member.name || "");
}

function memberType(member) {
  return typeof member === "string" ? "file" : String(member && (member.type || member.kind) || "file").toLowerCase();
}

/** Validate tar member names/types before extraction into a trusted workspace. */
export function validateArchiveMembers(members) {
  const values = Array.isArray(members) ? members : [];
  const errors = [];
  if (values.length > MAX_MEMBERS) errors.push(`archive has more than ${MAX_MEMBERS} members`);
  for (const member of values.slice(0, MAX_MEMBERS + 1)) {
    const name = memberName(member);
    const type = memberType(member);
    if (!name || name.length > MAX_MEMBER_CHARS) {
      errors.push("archive member path is missing or too long");
      continue;
    }
    if (name.includes("\0") || name.startsWith("/") || /^[A-Za-z]:[\\/]/.test(name)) errors.push(`unsafe archive member: ${name}`);
    const normalized = name.replaceAll("\\", "/");
    if (normalized.split("/").includes("..")) errors.push(`archive traversal member: ${name}`);
    if (["symlink", "hardlink", "link", "device", "char", "block", "fifo"].includes(type)) errors.push(`archive link/device member: ${name}`);
  }
  return { ok: errors.length === 0, errors: errors.slice(0, 8) };
}

function archiveMembers(archive) {
  const result = spawnSync("tar", ["-tvzf", archive], { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
  if (result.status !== 0) throw new Error(`ARCHIVE_LIST_FAILED ${result.stderr || result.stdout || "tar failed"}`);
  return String(result.stdout || "").split(/\r?\n/).filter(Boolean).map((line) => {
    const type = line[0] === "l" ? "symlink" : line[0] === "h" ? "hardlink" : line[0] === "p" ? "fifo" : line[0] === "c" ? "char" : line[0] === "b" ? "block" : "file";
    const match = line.match(/\s([^\s].*)$/);
    return { name: match ? match[1].replace(/\s+->\s+.*$/, "") : "", type };
  });
}

function supportedTarFlags(flags) {
  const help = spawnSync("tar", ["--help"], { encoding: "utf8", maxBuffer: 4 * 1024 * 1024 });
  const text = `${help.stdout || ""}\n${help.stderr || ""}`;
  return flags.filter((flag) => text.includes(flag));
}

export function safeExtractArchive(archive, targetDir) {
  if (!path.isAbsolute(archive) || !path.isAbsolute(targetDir)) throw new Error("ARCHIVE_PATHS_MUST_BE_ABSOLUTE");
  const members = archiveMembers(archive);
  const validation = validateArchiveMembers(members);
  if (!validation.ok) throw new Error(`ARCHIVE_REJECTED ${validation.errors.join("; ")}`);
  if (existsSync(targetDir)) throw new Error("ARCHIVE_TARGET_MUST_BE_NEW");
  mkdirSync(targetDir, { recursive: true, mode: 0o700 });
  const result = spawnSync("tar", [
    "--extract", "--file", archive, "--directory", targetDir,
    ...supportedTarFlags(["--no-same-owner", "--no-same-permissions", "--no-overwrite-dir", "--delay-directory-restore"]),
  ], { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
  if (result.status !== 0) {
    rmSync(targetDir, { recursive: true, force: true });
    throw new Error(`ARCHIVE_EXTRACT_FAILED ${result.stderr || result.stdout || "tar failed"}`);
  }
  for (const entry of readdirSync(targetDir, { recursive: true, withFileTypes: true })) {
    if (entry.isSymbolicLink()) {
      rmSync(targetDir, { recursive: true, force: true });
      throw new Error(`ARCHIVE_EXTRACT_LINK ${entry.name}`);
    }
  }
  return targetDir;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  try {
    safeExtractArchive(path.resolve(process.argv[2] || ""), path.resolve(process.argv[3] || ""));
  } catch (error) {
    console.error(String(error.message));
    process.exit(1);
  }
}
