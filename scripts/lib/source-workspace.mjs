import { spawnSync } from "node:child_process";
import path from "node:path";

import { createDisposableModelWorkspace, disposeModelWorkspace } from "./model.mjs";

const PUBLIC_REPO_RE = /^M1Vj\/[A-Za-z0-9._-]+$/;

/**
 * Create a disposable model workspace with a verified-public repository's
 * shallow clone mounted at source/. The public-read profile is refused unless
 * meta proves private=false and visibility=public.
 */
export function createPublicSourceWorkspace(repo, meta, {
  repoRoot = process.cwd(),
  stateRoot = process.env.FLEET_STATE_ROOT || "",
  spawnImpl = spawnSync,
} = {}) {
  const normalizedRepo = String(repo || "").trim();
  if (!PUBLIC_REPO_RE.test(normalizedRepo)) {
    throw new Error("PUBLIC_SOURCE_REPO_INVALID");
  }
  if (!meta || meta.private !== false || meta.visibility !== "public") {
    throw new Error("MODEL_PUBLIC_TARGET_REQUIRED");
  }
  if (meta.full_name !== normalizedRepo) throw new Error("PUBLIC_SOURCE_REPO_INVALID");
  const workspace = createDisposableModelWorkspace({
    repoRoot,
    stateRoot,
    prefix: "fleet-source-public-",
    profile: "public-read",
    publicTarget: meta,
  });
  const sourceDir = path.join(workspace, "source");
  try {
    const result = spawnImpl("git", [
      "-c", "credential.helper=",
      "clone", "--depth", "1", "--single-branch", "--no-tags",
      `https://github.com/${normalizedRepo}.git`,
      sourceDir,
    ], {
      env: {
        PATH: process.env.PATH || "/usr/bin:/bin:/usr/local/bin",
        HOME: workspace,
        TMPDIR: process.env.TMPDIR || "/tmp",
        GIT_CONFIG_GLOBAL: "/dev/null",
        GIT_CONFIG_SYSTEM: "/dev/null",
        GIT_TERMINAL_PROMPT: "0",
        GIT_ASKPASS: "",
      },
      encoding: "utf8",
      maxBuffer: 1024 * 1024,
    });
    if (result?.error || result?.status !== 0) throw new Error("PUBLIC_SOURCE_CLONE_FAILED");
    return { workspace, sourceDir };
  } catch (error) {
    disposeModelWorkspace(workspace);
    throw error;
  }
}
