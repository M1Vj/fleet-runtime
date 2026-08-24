function apiHeaders(token) {
  return {
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github+json",
    "User-Agent": "fleet-control",
    "X-GitHub-Api-Version": "2022-11-28",
  };
}

export async function apiGet(path, token, fetchImpl = globalThis.fetch) {
  const res = await fetchImpl(`https://api.github.com${path}`, { headers: apiHeaders(token) });
  if (!res.ok) throw new Error(`GET ${path} -> ${res.status}`);
  return res.json();
}

export async function expectUser(identity, token, fetchImpl = globalThis.fetch) {
  const user = await apiGet("/user", token, fetchImpl);
  if (user.login !== identity.login || user.type !== "User") {
    throw new Error(`ATTRIBUTION_PREFLIGHT_FAILED login=${user.login} type=${user.type}`);
  }
  if (user.login.includes("[bot]")) {
    throw new Error("ATTRIBUTION_PREFLIGHT_FAILED bot marker");
  }
  return user;
}

export async function verifyCommit(repoFullName, sha, identity, token, fetchImpl = globalThis.fetch) {
  const c = await apiGet(`/repos/${repoFullName}/commits/${sha}`, token, fetchImpl);
  const authorLogin = c.author && c.author.login;
  const authorEmail = c.commit && c.commit.author && c.commit.author.email;
  const committerEmail = c.commit && c.commit.committer && c.commit.committer.email;
  const problems = [];
  if (authorLogin !== identity.login) problems.push(`author.login=${authorLogin}`);
  if (authorEmail !== identity.noreply) problems.push(`author.email=${authorEmail}`);
  if (committerEmail !== identity.noreply) problems.push(`committer.email=${committerEmail}`);
  if ((authorLogin || "").includes("[bot]")) problems.push("bot attribution detected");
  if (problems.length > 0) {
    throw new Error(`ATTRIBUTION_MISMATCH ${repoFullName}@${sha.slice(0, 10)} ${problems.join("; ")}`);
  }
  return true;
}

export async function verifyIssueAuthor(repoFullName, number, identity, token, fetchImpl = globalThis.fetch) {
  const issue = await apiGet(`/repos/${repoFullName}/issues/${number}`, token, fetchImpl);
  const login = issue.user && issue.user.login;
  if (login !== identity.login) throw new Error(`ATTRIBUTION_MISMATCH issue#${number} creator=${login}`);
  return true;
}

export async function verifyCommentAuthor(repoFullName, commentId, identity, token, fetchImpl = globalThis.fetch) {
  const comment = await apiGet(`/repos/${repoFullName}/issues/comments/${commentId}`, token, fetchImpl);
  const login = comment.user && comment.user.login;
  if (login !== identity.login) throw new Error(`ATTRIBUTION_MISMATCH comment#${commentId} creator=${login}`);
  return true;
}

export async function verifyPullAuthor(repoFullName, number, identity, token, fetchImpl = globalThis.fetch, { requireDraft = true } = {}) {
  const pull = await apiGet(`/repos/${repoFullName}/pulls/${number}`, token, fetchImpl);
  const login = pull.user && pull.user.login;
  if (login !== identity.login) throw new Error(`ATTRIBUTION_MISMATCH pr#${number} creator=${login}`);
  if (requireDraft && pull.draft !== true) throw new Error(`SAFETY_MISMATCH pr#${number} not draft`);
  return true;
}

export async function verifyMergePullAuthor(repoFullName, number, identity, token, fetchImpl = globalThis.fetch) {
  return verifyPullAuthor(repoFullName, number, identity, token, fetchImpl, { requireDraft: false });
}
