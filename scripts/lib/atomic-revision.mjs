import { isRevisionPathPolicySafe } from "./revision-queue.mjs";

const SHA_RE = /^[a-f0-9]{40}$/i;
const BRANCH_RE = /^fleet\/[a-z0-9][a-z0-9-]{4,100}$/;

function requireSha(value, label) {
  if (!SHA_RE.test(String(value || ""))) throw new Error(`${label} must be a 40-hex SHA`);
  return String(value);
}

function assertBranch(branch) {
  if (!BRANCH_RE.test(String(branch || ""))) throw new Error("revision branch must be fleet/<kebab>");
  return String(branch);
}

function requireAttribution(identity) {
  const name = typeof identity?.name === "string" ? identity.name.trim() : "";
  const email = typeof identity?.noreply === "string" ? identity.noreply.trim() : "";
  if (!name || !email || /[\r\n]/.test(name) || /[\r\n]/.test(email)) throw new Error("revision attribution is required");
  return { name, email };
}

function assertBaseTreeSafe(tree, targetPaths) {
  if (!tree || tree.truncated === true) throw new Error("BASE_TREE_TRUNCATED");
  if (!Array.isArray(tree.tree)) throw new Error("BASE_TREE_INVALID");
  const affectsTarget = (entryPath) => typeof entryPath === "string" && entryPath.length > 0
    && [...targetPaths].some((targetPath) => targetPath === entryPath || targetPath.startsWith(`${entryPath}/`));
  for (const entry of tree.tree.filter((candidate) => affectsTarget(candidate && candidate.path))) {
    if (entry && (entry.mode === "120000" || entry.type === "symlink")) throw new Error(`BASE_TREE_SYMLINK ${entry.path || ""}`);
    if (entry && (entry.mode === "160000" || entry.type === "commit")) throw new Error(`BASE_TREE_SUBMODULE ${entry.path || ""}`);
    if (entry && (entry.mode === "040000" || entry.type === "tree") && !targetPaths.has(entry.path)) continue;
    if (entry && entry.mode && !["100644", "100755"].includes(entry.mode)) throw new Error(`BASE_TREE_MODE_UNSUPPORTED ${entry.path || ""}`);
  }
}

/**
 * Build and publish one Git Data API commit. The API object is intentionally
 * pluggable so tests can prove ordering and race behavior without network calls.
 */
export async function applyAtomicRevision({ api, repo, branch, expectedHead, files, message, identity }) {
  if (!api || typeof api.getCommit !== "function" || typeof api.getTree !== "function" || typeof api.createBlob !== "function" || typeof api.createTree !== "function" || typeof api.createCommit !== "function" || typeof api.getRef !== "function" || typeof api.updateRef !== "function") {
    throw new Error("atomic revision API is incomplete");
  }
  if (!/^M1Vj\/[A-Za-z0-9_.-]+$/.test(String(repo || ""))) throw new Error("atomic revision repo is not authorized");
  const head = requireSha(expectedHead, "expected head");
  const targetBranch = assertBranch(branch);
  const attribution = requireAttribution(identity);
  if (!Array.isArray(files) || files.length === 0) throw new Error("atomic revision requires files");
  for (const file of files) {
    if (!file || typeof file.path !== "string" || !isRevisionPathPolicySafe(file.path)) throw new Error(`unsafe revision path ${file && file.path || ""}`);
    if (typeof file.content !== "string") throw new Error(`revision content must be text ${file.path}`);
  }

  const initialRef = await api.getRef(repo, targetBranch);
  if (!initialRef || !initialRef.object || initialRef.object.sha !== head) throw new Error("STALE_REF");

  const expectedCommit = await api.getCommit(repo, head);
  const expectedCommitSha = expectedCommit && expectedCommit.sha ? expectedCommit.sha : head;
  if (expectedCommitSha !== head) throw new Error("EXPECTED_COMMIT_MISMATCH");
  const baseTreeSha = expectedCommit && expectedCommit.tree && expectedCommit.tree.sha;
  requireSha(baseTreeSha, "base tree");
  const baseTree = await api.getTree(repo, baseTreeSha);
  const targetPaths = new Set(files.map((file) => file.path));
  assertBaseTreeSafe(baseTree, targetPaths);

  const entries = [];
  for (const file of files) {
    const blob = await api.createBlob(repo, { content: file.content, encoding: "utf-8" });
    requireSha(blob && blob.sha, `blob for ${file.path}`);
    const existing = baseTree.tree.find((entry) => entry && entry.path === file.path);
    entries.push({ path: file.path, mode: existing && existing.mode === "100755" ? "100755" : "100644", type: "blob", sha: blob.sha });
  }
  const tree = await api.createTree(repo, { base_tree: baseTreeSha, tree: entries });
  requireSha(tree && tree.sha, "new tree");
  const commit = await api.createCommit(repo, {
    message: String(message || "[fleet-revise] atomic update"),
    tree: tree.sha,
    parents: [head],
    author: attribution,
    committer: attribution,
  });
  const commitSha = requireSha(commit && commit.sha, "new commit");
  if (!Array.isArray(commit.parents) || commit.parents.length !== 1 || commit.parents[0].sha !== head) {
    throw new Error("ATOMIC_PARENT_MISMATCH");
  }

  // This is deliberately the last read before PATCH. A changed ref fails closed
  // and leaves all generated objects unreachable without changing the branch.
  const currentRef = await api.getRef(repo, targetBranch);
  if (!currentRef || !currentRef.object || currentRef.object.sha !== head) throw new Error("STALE_REF");
  await api.updateRef(repo, targetBranch, { sha: commitSha, force: false });
  const finalRef = await api.getRef(repo, targetBranch);
  if (!finalRef || !finalRef.object || finalRef.object.sha !== commitSha) throw new Error("ATOMIC_REF_VERIFY_FAILED");
  const resultingCommit = await api.getCommit(repo, commitSha);
  if (!resultingCommit || !Array.isArray(resultingCommit.parents) || resultingCommit.parents.length !== 1 || resultingCommit.parents[0].sha !== head) {
    throw new Error("ATOMIC_COMMIT_VERIFY_FAILED");
  }
  return { commitSha, treeSha: tree.sha, branch: targetBranch, parentSha: head };
}
