import path from "node:path";

import { gh } from "./util.mjs";
import { createDisposableModelWorkspace, disposeModelWorkspace } from "./model.mjs";

/**
 * Create a disposable model workspace with a verified-public repository's
 * shallow clone mounted at source/. The public-read profile is refused unless
 * meta proves private=false and visibility=public.
 */
export function createPublicSourceWorkspace(repo, meta, { repoRoot = process.cwd(), stateRoot = process.env.FLEET_STATE_ROOT || "" } = {}) {
  const workspace = createDisposableModelWorkspace({
    repoRoot,
    stateRoot,
    prefix: "fleet-source-public-",
    profile: "public-read",
    publicTarget: meta,
  });
  const sourceDir = path.join(workspace, "source");
  try {
    gh(["repo", "clone", String(repo), sourceDir, "--", "--depth", "1"]);
    return { workspace, sourceDir };
  } catch (error) {
    disposeModelWorkspace(workspace);
    throw error;
  }
}
