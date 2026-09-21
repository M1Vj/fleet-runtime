import { test } from "node:test";
import assert from "node:assert/strict";
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { ensureBranch, putFileContent } from "../scripts/lib/util.mjs";

const REPO = "acme/repo";
const FILE = "file.md";
const BRANCH = "main";

const FAKE_GH = `#!/bin/sh
ROOT=$(CDPATH= cd -- "$(dirname "$0")" && pwd)
printf '%s\\n' "$*" >> "$ROOT/calls.log"

run_response() {
  name="$1"
  status=$(cat "$ROOT/$name.status")
  if [ -f "$ROOT/$name.stdout" ]; then cat "$ROOT/$name.stdout"; fi
  if [ -f "$ROOT/$name.stderr" ]; then cat "$ROOT/$name.stderr" >&2; fi
  exit "$status"
}

case "$*" in
  *"actions/variables/FLEET_KILL_SWITCH"*) printf '%s\\n' '{"name":"FLEET_KILL_SWITCH","value":"clear"}' ;;
  *"-X PUT /repos/acme/repo/contents/file.md"*) run_response put ;;
  *"-X POST /repos/acme/repo/git/refs"*) run_response post ;;
  *) run_response get ;;
esac
`;

function fakeGh({ get, put, post } = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), "fleet-util-gh-"));
  const bin = path.join(dir, "gh");
  writeFileSync(bin, FAKE_GH, { mode: 0o700 });
  chmodSync(bin, 0o700);
  writeFileSync(path.join(dir, "calls.log"), "", { mode: 0o600 });

  const responses = {
    get: get || { status: 0, stdout: '{"sha":"existing-sha"}' },
    put: put || { status: 0, stdout: '{"ok":true}' },
    post: post || { status: 0, stdout: '{"ok":true}' },
  };
  for (const [name, response] of Object.entries(responses)) {
    writeFileSync(path.join(dir, `${name}.status`), String(response.status ?? 0));
    if (response.stdout !== undefined) writeFileSync(path.join(dir, `${name}.stdout`), String(response.stdout));
    if (response.stderr !== undefined) writeFileSync(path.join(dir, `${name}.stderr`), String(response.stderr));
  }

  const env = {
    FLEET_GH_TOKEN: "ghp_test_secret_value",
    FLEET_CONTROL_REPOSITORY: "private-owner/control-plane",
    FLEET_KILL_SWITCH_REPOSITORY: "private-owner/control-plane",
    FLEET_KILL_SWITCH_VARIABLE: "FLEET_KILL_SWITCH",
    PATH: `${dir}:${process.env.PATH || ""}`,
    HOME: dir,
    TMPDIR: dir,
  };
  return {
    env,
    callsPath: path.join(dir, "calls.log"),
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

function calls(callsPath) {
  const body = readFileSync(callsPath, "utf8").trim();
  return body ? body.split("\n").filter((line) => !line.includes("actions/variables/FLEET_KILL_SWITCH")) : [];
}

function put(env) {
  return putFileContent(REPO, FILE, "hello", BRANCH, "update", env);
}

test("putFileContent updates an existing file using its authoritative sha", () => {
  const gh = fakeGh({ get: { status: 0, stdout: '{"sha":"old-sha"}' } });
  try {
    const result = put(gh.env);
    assert.deepEqual(result, { ok: true });
    const invocations = calls(gh.callsPath);
    assert.equal(invocations.length, 2);
    assert.match(invocations[0], /contents\/file\.md\?ref=main/);
    assert.match(invocations[1], /-X PUT .*contents\/file\.md/);
  } finally {
    gh.cleanup();
  }
});

test("putFileContent creates only after an authoritative 404", () => {
  const gh = fakeGh({
    get: {
      status: 1,
      stderr: '{"message":"Not Found","status":"404","documentation_url":"https://docs.github.com/rest"}',
    },
  });
  try {
    assert.deepEqual(put(gh.env), { ok: true });
    assert.equal(calls(gh.callsPath).filter((line) => /-X PUT /.test(line)).length, 1);
  } finally {
    gh.cleanup();
  }
});

test("putFileContent accepts the gh CLI's authoritative 404 form", () => {
  const gh = fakeGh({ get: { status: 1, stderr: "gh: Not Found (HTTP 404)" } });
  try {
    assert.deepEqual(put(gh.env), { ok: true });
    assert.equal(calls(gh.callsPath).filter((line) => /-X PUT /.test(line)).length, 1);
  } finally {
    gh.cleanup();
  }
});

for (const status of [401, 403, 409, 422, 429, 500]) {
  test(`putFileContent fails closed for HTTP ${status} without a PUT`, () => {
    const token = "ghp_test_secret_value";
    const gh = fakeGh({
      get: {
        status: 1,
        stderr: JSON.stringify({ message: `request failed ${token}`, status: String(status) }),
      },
    });
    try {
      assert.throws(() => put(gh.env), (err) => {
        assert.doesNotMatch(String(err), new RegExp(token, "g"));
        return err?.status === status;
      });
      assert.equal(calls(gh.callsPath).filter((line) => /-X PUT /.test(line)).length, 0);
    } finally {
      gh.cleanup();
    }
  });
}

test("putFileContent fails closed for a network error without a PUT", () => {
  const gh = fakeGh({ get: { status: 1, stderr: "network connection reset" } });
  try {
    assert.throws(() => put(gh.env), (err) => err?.kind === "network");
    assert.equal(calls(gh.callsPath).filter((line) => /-X PUT /.test(line)).length, 0);
  } finally {
    gh.cleanup();
  }
});

test("putFileContent fails closed for a malformed successful GET without a PUT", () => {
  const gh = fakeGh({ get: { status: 0, stdout: "not-json" } });
  try {
    assert.throws(() => put(gh.env), /malformed/i);
    assert.equal(calls(gh.callsPath).filter((line) => /-X PUT /.test(line)).length, 0);
  } finally {
    gh.cleanup();
  }
});

test("ensureBranch treats the exact matching 422 already-exists response as idempotent", () => {
  const gh = fakeGh({
    post: {
      status: 1,
      stderr: JSON.stringify({
        message: "Reference already exists",
        status: "422",
        ref: "refs/heads/main",
      }),
    },
  });
  try {
    assert.equal(ensureBranch(REPO, BRANCH, "base-sha", gh.env), "exists");
    assert.equal(calls(gh.callsPath).length, 1);
  } finally {
    gh.cleanup();
  }
});

test("ensureBranch accepts the gh CLI's exact already-exists 422 form", () => {
  const gh = fakeGh({ post: { status: 1, stderr: "gh: Reference already exists (HTTP 422)" } });
  try {
    assert.equal(ensureBranch(REPO, BRANCH, "base-sha", gh.env), "exists");
  } finally {
    gh.cleanup();
  }
});

test("ensureBranch fails for an unrelated 422 response", () => {
  const gh = fakeGh({
    post: {
      status: 1,
      stderr: JSON.stringify({ message: "Validation Failed", status: "422" }),
    },
  });
  try {
    assert.throws(() => ensureBranch(REPO, BRANCH, "base-sha", gh.env), (err) => err?.status === 422);
    assert.equal(calls(gh.callsPath).length, 1);
  } finally {
    gh.cleanup();
  }
});

test("ensureBranch fails when an already-exists body names a different ref", () => {
  const gh = fakeGh({
    post: {
      status: 1,
      stderr: JSON.stringify({
        message: "Reference already exists",
        status: "422",
        ref: "refs/heads/other",
      }),
    },
  });
  try {
    assert.throws(() => ensureBranch(REPO, BRANCH, "base-sha", gh.env), (err) => err?.status === 422);
  } finally {
    gh.cleanup();
  }
});
