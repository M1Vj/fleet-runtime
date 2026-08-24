import { test } from "node:test";
import assert from "node:assert/strict";

import { applyAtomicRevision } from "../scripts/lib/atomic-revision.mjs";

const expectedHead = "a".repeat(40);
const identity = { name: "Vj Mabansag", noreply: "123+M1Vj@users.noreply.github.com" };

function fakeApi({ currentRef = expectedHead, treeEntries = [], race = false, raceAtUpdate = false } = {}) {
  const calls = [];
  let ref = currentRef;
  let commitSha = "c".repeat(40);
  return {
    calls,
    getCommit: async (repo, sha) => {
      calls.push(["getCommit", repo, sha]);
      return sha === expectedHead
        ? { sha, tree: { sha: "d".repeat(40) } }
        : { sha, parents: [{ sha: expectedHead }] };
    },
    getTree: async (repo, sha) => {
      calls.push(["getTree", repo, sha]);
      return { sha, truncated: false, tree: treeEntries };
    },
    createBlob: async (repo, body) => {
      calls.push(["createBlob", repo, body]);
      return { sha: `${String(calls.length).padStart(40, "b")}`.slice(0, 40) };
    },
    createTree: async (repo, body) => {
      calls.push(["createTree", repo, body]);
      return { sha: "e".repeat(40) };
    },
    createCommit: async (repo, body) => {
      calls.push(["createCommit", repo, body]);
      return { sha: commitSha, parents: [{ sha: expectedHead }] };
    },
    getRef: async (repo, branch) => {
      calls.push(["getRef", repo, branch]);
      if (race && calls.filter(([kind]) => kind === "getRef").length === 1) ref = "f".repeat(40);
      return { object: { sha: ref } };
    },
    updateRef: async (repo, branch, body) => {
      calls.push(["updateRef", repo, branch, body]);
      if (body.force) throw new Error("force update forbidden");
      if (raceAtUpdate) throw new Error("422 non-fast-forward");
      if (ref !== expectedHead) throw new Error("422 non-fast-forward");
      ref = body.sha;
      return { object: { sha: ref } };
    },
    currentRef: () => ref,
  };
}

test("two validated files produce one blob tree commit and one non-force ref update", async () => {
  const api = fakeApi();
  const result = await applyAtomicRevision({
    api,
    repo: "M1Vj/example-repo",
    branch: "fleet/fix-one",
    expectedHead,
    identity,
    files: [
      { path: "src/a.js", content: "a" },
      { path: "src/b.js", content: "b" },
    ],
    message: "[fleet-revise] atomic update",
  });
  assert.equal(result.commitSha, "c".repeat(40));
  assert.equal(api.calls.filter(([kind]) => kind === "createCommit").length, 1);
  assert.equal(api.calls.filter(([kind]) => kind === "updateRef").length, 1);
  const update = api.calls.find(([kind]) => kind === "updateRef");
  assert.equal(update[3].force, false);
  const commit = api.calls.find(([kind]) => kind === "createCommit");
  assert.deepEqual(commit[2].parents, [expectedHead]);
  assert.deepEqual(commit[2].author, { name: identity.name, email: identity.noreply });
  assert.deepEqual(commit[2].committer, { name: identity.name, email: identity.noreply });
});

test("stale ref is rejected before creating any Git objects or updating the ref", async () => {
  const api = fakeApi({ race: true });
  await assert.rejects(
    applyAtomicRevision({ api, repo: "M1Vj/example-repo", branch: "fleet/fix-one", expectedHead, identity, files: [{ path: "src/a.js", content: "a" }], message: "update" }),
    /STALE_REF|non-fast-forward/i,
  );
  assert.equal(api.calls.some(([kind]) => kind === "createBlob"), false);
  assert.equal(api.calls.some(([kind]) => kind === "createTree"), false);
  assert.equal(api.calls.some(([kind]) => kind === "createCommit"), false);
  assert.equal(api.calls.some(([kind]) => kind === "updateRef"), false);
});

test("a non-fast-forward race rejects the non-force ref update and leaves the branch unchanged", async () => {
  const api = fakeApi({ raceAtUpdate: true });
  await assert.rejects(
    applyAtomicRevision({ api, repo: "M1Vj/example-repo", branch: "fleet/fix-one", expectedHead, identity, files: [{ path: "src/a.js", content: "a" }], message: "update" }),
    /non-fast-forward/i,
  );
  assert.equal(api.currentRef(), expectedHead);
  const update = api.calls.find(([kind]) => kind === "updateRef");
  assert.equal(update[3].force, false);
});

test("truncated trees and symlink/submodule entries are rejected before blobs", async () => {
  for (const tree of [
    { truncated: true, tree: [] },
    { truncated: false, tree: [{ path: "src/a.js", mode: "120000", type: "blob", sha: "1" }] },
    { truncated: false, tree: [{ path: "src/a.js", mode: "160000", type: "commit", sha: "2" }] },
  ]) {
    const api = fakeApi();
    api.getTree = async (repo, sha) => ({ sha, ...tree });
    await assert.rejects(
      applyAtomicRevision({ api, repo: "M1Vj/example-repo", branch: "fleet/fix-one", expectedHead, identity, files: [{ path: "src/a.js", content: "a" }], message: "update" }),
      /truncated|symlink|submodule/i,
    );
    assert.equal(api.calls.some(([kind]) => kind === "createBlob"), false);
  }
});

test("existing executable mode is preserved while new support files default to regular mode", async () => {
  const api = fakeApi({ treeEntries: [{ path: "src/a.js", mode: "100755", type: "blob", sha: "1" }] });
  const result = await applyAtomicRevision({
    api,
    repo: "M1Vj/example-repo",
    branch: "fleet/fix-one",
    expectedHead,
    identity,
    files: [{ path: "src/a.js", content: "a" }, { path: "docs/new.md", content: "n" }],
    message: "update",
  });
  assert.equal(result.commitSha, "c".repeat(40));
  const tree = api.calls.find(([kind]) => kind === "createTree");
  assert.equal(tree[2].tree.find((entry) => entry.path === "src/a.js").mode, "100755");
  assert.equal(tree[2].tree.find((entry) => entry.path === "docs/new.md").mode, "100644");
});

test("unrelated symlink entries do not block a regular target update", async () => {
  const api = fakeApi({ treeEntries: [
    { path: "vendor/link", mode: "120000", type: "blob", sha: "1" },
    { path: "src/a.js", mode: "100644", type: "blob", sha: "2" },
  ] });
  const result = await applyAtomicRevision({
    api,
    repo: "M1Vj/example-repo",
    branch: "fleet/fix-one",
    expectedHead,
    identity,
    files: [{ path: "src/a.js", content: "a" }],
    message: "update",
  });
  assert.equal(result.commitSha, "c".repeat(40));
});

test("a symlink ancestor of a target path is rejected before creating blobs", async () => {
  const api = fakeApi({ treeEntries: [
    { path: "src", mode: "120000", type: "blob", sha: "1" },
  ] });
  await assert.rejects(
    applyAtomicRevision({
      api,
      repo: "M1Vj/example-repo",
      branch: "fleet/fix-one",
      expectedHead,
      identity,
      files: [{ path: "src/a.js", content: "a" }],
      message: "update",
    }),
    /symlink/i,
  );
  assert.equal(api.calls.some(([kind]) => kind === "createBlob"), false);
});

test("normal tree ancestors do not block a nested source update", async () => {
  const api = fakeApi({ treeEntries: [
    { path: "src", mode: "040000", type: "tree", sha: "1" },
    { path: "src/a.js", mode: "100644", type: "blob", sha: "2" },
  ] });
  const result = await applyAtomicRevision({
    api,
    repo: "M1Vj/example-repo",
    branch: "fleet/fix-one",
    expectedHead,
    identity,
    files: [{ path: "src/a.js", content: "a" }],
    message: "update",
  });
  assert.equal(result.commitSha, "c".repeat(40));
});
