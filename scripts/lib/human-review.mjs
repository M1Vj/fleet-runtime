import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import { gh } from "./util.mjs";
import { verifyCommentAuthor } from "./verify.mjs";

export function queuePaths(stateRoot) {
  const root = stateRoot || process.cwd();
  return {
    jsonPath: path.join(root, "state", "human-review-queue.json"),
    mdPath: path.join(root, "state", "HUMAN_REVIEW_QUEUE.md"),
  };
}

export function loadQueue(stateRoot) {
  const { jsonPath } = queuePaths(stateRoot);
  try {
    if (existsSync(jsonPath)) {
      const data = JSON.parse(readFileSync(jsonPath, "utf8"));
      return {
        active: Array.isArray(data.active) ? data.active : [],
        resolved: Array.isArray(data.resolved) ? data.resolved : [],
      };
    }
  } catch {}
  return { active: [], resolved: [] };
}

export function saveQueue(stateRoot, data) {
  const { jsonPath, mdPath } = queuePaths(stateRoot);
  const queueData = {
    active: Array.isArray(data?.active) ? data.active : [],
    resolved: Array.isArray(data?.resolved) ? data.resolved : [],
  };

  mkdirSync(path.dirname(jsonPath), { recursive: true });
  writeFileSync(jsonPath, JSON.stringify(queueData, null, 2) + "\n", "utf8");

  const mdContent = renderHumanReviewMarkdown(queueData.active, queueData.resolved);
  mkdirSync(path.dirname(mdPath), { recursive: true });
  writeFileSync(mdPath, mdContent, "utf8");
}

export function recordHumanReview(stateRoot, item) {
  const queue = loadQueue(stateRoot);
  const now = new Date().toISOString();

  const entry = {
    repo: String(item.repo || ""),
    prNumber: Number(item.prNumber || 0),
    title: String(item.title || ""),
    headSha: String(item.headSha || ""),
    author: String(item.author || "M1Vj"),
    branch: String(item.branch || ""),
    category: String(item.category || "manual-review"),
    why: String(item.why || ""),
    scores: Array.isArray(item.scores) ? item.scores : [],
    deterministic: item.deterministic !== undefined ? item.deterministic : true,
    visual: item.visual !== undefined ? item.visual : null,
    updatedAt: item.updatedAt || now,
    prUrl: item.prUrl || `https://github.com/${item.repo}/pull/${item.prNumber}`,
  };

  const existingIndex = queue.active.findIndex(
    (a) => a.repo === entry.repo && Number(a.prNumber) === Number(entry.prNumber)
  );

  if (existingIndex >= 0) {
    queue.active[existingIndex] = { ...queue.active[existingIndex], ...entry, updatedAt: now };
  } else {
    queue.active.push(entry);
  }

  saveQueue(stateRoot, queue);
  return entry;
}

export function resolveHumanReviewItem(stateRoot, repo, prNumber, resolution = "merged") {
  const queue = loadQueue(stateRoot);
  const prNum = Number(prNumber);
  const idx = queue.active.findIndex(
    (a) => a.repo === repo && Number(a.prNumber) === prNum
  );

  if (idx < 0) return false;

  const [item] = queue.active.splice(idx, 1);
  const resolvedItem = {
    ...item,
    resolution,
    resolvedAt: new Date().toISOString(),
  };

  queue.resolved.unshift(resolvedItem);
  if (queue.resolved.length > 50) {
    queue.resolved = queue.resolved.slice(0, 50);
  }

  saveQueue(stateRoot, queue);
  return true;
}

export async function reconcileHumanReviewQueue(stateRoot, env = process.env) {
  const queue = loadQueue(stateRoot);
  if (!queue.active || queue.active.length === 0) return 0;

  let reconciledCount = 0;
  const stillActive = [];

  for (const item of queue.active) {
    try {
      const pr = gh(["api", `/repos/${item.repo}/pulls/${item.prNumber}`], env);
      if (pr && (pr.state === "closed" || pr.merged)) {
        const resolution = pr.merged ? "merged" : "closed";
        queue.resolved.unshift({
          ...item,
          resolution,
          resolvedAt: new Date().toISOString(),
        });
        reconciledCount++;

        try {
          gh(
            ["api", "-X", "DELETE", `/repos/${item.repo}/issues/${item.prNumber}/labels/fleet%3Aneeds-human-review`],
            env
          );
        } catch {}
      } else {
        stillActive.push(item);
      }
    } catch {
      stillActive.push(item);
    }
  }

  if (reconciledCount > 0) {
    queue.active = stillActive;
    if (queue.resolved.length > 50) {
      queue.resolved = queue.resolved.slice(0, 50);
    }
    saveQueue(stateRoot, queue);
  }

  return reconciledCount;
}

export function renderHumanReviewMarkdown(active = [], resolved = []) {
  const lines = [];
  lines.push("# 🛡️ Fleet Human Review Queue");
  lines.push("");
  lines.push("> Real-time queue for pull requests requiring human review, subjective UI/UX inspection, or escalation.");
  lines.push("");
  lines.push(`- **Last Updated**: \`${new Date().toISOString()}\``);
  lines.push(`- **Active Items**: \`${active.length}\``);
  lines.push(`- **Resolved Items**: \`${resolved.length}\``);
  lines.push("");

  lines.push("## 📋 Active PRs Needing Human Review");
  lines.push("");

  if (active.length === 0) {
    lines.push("🎉 *No pull requests currently require human review. Fleet operations are running fully autonomous.*");
    lines.push("");
  } else {
    for (const item of active) {
      lines.push(`### [${item.repo}#${item.prNumber}: ${item.title}](${item.prUrl})`);
      lines.push("");
      lines.push(`- **Category**: \`${item.category}\``);
      lines.push(`- **Author**: \`${item.author}\` | **Branch**: \`${item.branch}\` | **Head SHA**: \`${(item.headSha || "").slice(0, 10)}\``);
      lines.push(`- **Queued / Updated**: \`${item.updatedAt}\``);
      lines.push(`- **Deterministic Checks**: \`${item.deterministic ? "PASSED" : "FAILED"}\``);
      lines.push(`- **Why**: ${item.why}`);

      if (Array.isArray(item.scores) && item.scores.length > 0) {
        lines.push(`- **Audit Scores**: ${item.scores.map((s) => `\`${s.lens || s.name || "score"}: ${s.score ?? s}\``).join(" | ")}`);
      }

      if (item.visual) {
        lines.push("- **Visual Check Summary**:");
        if (item.visual.diffPct !== undefined && item.visual.diffPct >= 0) {
          lines.push(`  * Pixel Diff: \`${Number(item.visual.diffPct).toFixed(2)}%\``);
        }
        if (item.visual.consoleErrors !== undefined) {
          lines.push(`  * Console Errors: \`${item.visual.consoleErrors}\``);
        }
        if (item.visual.a11yBlocker !== undefined) {
          lines.push(`  * Critical A11y Violations: \`${item.visual.a11yBlocker ? "YES" : "0"}\``);
        }
        if (item.visual.vlm) {
          lines.push(`  * Vision Judge: \`${item.visual.vlm.verdict || "n/a"}\` (Score: \`${item.visual.vlm.score ?? "n/a"}\`)`);
        }
      }

      lines.push("");
      lines.push("**Merge Command**:");
      lines.push("```bash");
      lines.push(`gh pr merge ${item.prNumber} --repo ${item.repo} --merge`);
      lines.push("```");
      lines.push("");
    }
  }

  lines.push("## 📜 Recently Resolved (Last 50)");
  lines.push("");

  if (resolved.length === 0) {
    lines.push("*No resolved reviews recorded yet.*");
    lines.push("");
  } else {
    lines.push("| Repo | PR | Title | Category | Resolution | Resolved At |");
    lines.push("| --- | --- | --- | --- | --- | --- |");
    for (const r of resolved) {
      lines.push(`| \`${r.repo}\` | [#${r.prNumber}](${r.prUrl}) | ${String(r.title).replace(/\|/g, "\\|")} | \`${r.category}\` | \`${r.resolution}\` | \`${r.resolvedAt || r.updatedAt}\` |`);
    }
    lines.push("");
  }

  return lines.join("\n");
}

export async function tagPrNeedsHumanReview(repo, prNumber, category, why, audit, env = process.env) {
  const marker = "<!-- fleet:needs-human-review -->";

  try {
    const comments = gh(["api", `/repos/${repo}/issues/${prNumber}/comments?per_page=20`], env) || [];
    if (comments.some((c) => c.body && String(c.body).includes(marker))) {
      if (audit && typeof audit.note === "function") {
        audit.note("human-review-dedupe", `#${prNumber} human review comment already present`);
      }
      return null;
    }
  } catch {}

  const labelsToAdd = ["fleet:needs-human-review"];
  if (category === "ui-ux") {
    labelsToAdd.push("fleet:ui-ux");
  }

  for (const label of labelsToAdd) {
    try {
      gh(["api", "-X", "POST", `/repos/${repo}/issues/${prNumber}/labels`, "-f", `labels[]=${label}`], env);
    } catch (addErr) {
      try {
        gh(["api", "-X", "POST", `/repos/${repo}/labels`, "-f", `name=${label}`, "-f", "color=f2994a"], env);
      } catch (createErr) {
        if (!/422|already.?exists/i.test(String(createErr.message))) throw createErr;
      }
      try {
        gh(["api", "-X", "POST", `/repos/${repo}/issues/${prNumber}/labels`, "-f", `labels[]=${label}`], env);
      } catch (retryErr) {
        if (!/422|already/i.test(String(retryErr.message))) throw retryErr;
      }
      void addErr;
    }
  }

  const commentBody = [
    marker,
    "### 🛡️ Fleet Human Review Required",
    "",
    `This pull request has been classified as **\`${category}\`** and requires human review.`,
    "",
    `**Reason**: ${why}`,
    "",
    "All automated checks (deterministic and multi-agent audit panel) have completed. To approve and merge:",
    "```bash",
    `gh pr merge ${prNumber} --repo ${repo} --merge`,
    "```",
  ].join("\n");

  const c = gh(["api", "-X", "POST", `/repos/${repo}/issues/${prNumber}/comments`, "-F", `body=${commentBody}`], env);
  const user = gh(["api", `/repos/${repo}/issues/comments/${c.id}`], env);
  if ((user.user && user.user.login) !== "M1Vj") throw new Error("comment attribution mismatch");
  await verifyCommentAuthor(repo, c.id, { login: "M1Vj" }, env.FLEET_GH_TOKEN);

  if (audit && typeof audit.note === "function") {
    audit.note("human-review-tag", `Tagged ${repo}#${prNumber} as ${category}`);
  }

  return c;
}
