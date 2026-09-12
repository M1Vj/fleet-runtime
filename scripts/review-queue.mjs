#!/usr/bin/env node
import process from "node:process";
import { gh } from "./lib/util.mjs";
import { loadQueue, resolveHumanReviewItem, reconcileHumanReviewQueue } from "./lib/human-review.mjs";

const STATE_ROOT = process.env.FLEET_STATE_ROOT || process.cwd();

async function main() {
  const args = process.argv.slice(2);
  const mergeIdx = args.indexOf("--merge");

  if (mergeIdx >= 0 && args[mergeIdx + 1]) {
    const target = args[mergeIdx + 1].trim(); // expected: repo#pr or repo pr
    let repo = "";
    let prNumber = 0;
    if (target.includes("#")) {
      const parts = target.split("#");
      repo = parts[0];
      prNumber = Number(parts[1]);
    } else if (args[mergeIdx + 2]) {
      repo = target;
      prNumber = Number(args[mergeIdx + 2]);
    }

    if (!repo || !prNumber) {
      console.error("Usage: node scripts/review-queue.mjs --merge <repo#pr>");
      process.exit(1);
    }

    console.log(`Approving and merging ${repo}#${prNumber}...`);
    try {
      gh(["pr", "merge", String(prNumber), "--merge", "--delete-branch", "-R", repo], process.env);
      resolveHumanReviewItem(STATE_ROOT, repo, prNumber, "manually-merged");
      try {
        gh(["api", "-X", "DELETE", `/repos/${repo}/issues/${prNumber}/labels/fleet%3Aneeds-human-review`], process.env);
      } catch {}
      console.log(`Successfully merged ${repo}#${prNumber} and resolved in human review queue.`);
      process.exit(0);
    } catch (err) {
      console.error(`Failed to merge ${repo}#${prNumber}: ${err.message}`);
      process.exit(1);
    }
  }

  // Otherwise display active queue
  const queue = loadQueue(STATE_ROOT);
  console.log("\n=== 🛡️  FLEET HUMAN REVIEW QUEUE ===");
  console.log(`Active PRs needing attention: ${queue.active.length}`);
  console.log(`Total resolved historical PRs: ${queue.resolved.length}\n`);

  if (queue.active.length === 0) {
    console.log("✅ All clear! No PRs currently need human review. Fleet is fully autonomous.\n");
    return;
  }

  for (const item of queue.active) {
    console.log(`------------------------------------------------------------`);
    console.log(`PR:       ${item.repo}#${item.prNumber} - ${item.title}`);
    console.log(`Category: [${item.category.toUpperCase()}]`);
    console.log(`Why:      ${item.why}`);
    console.log(`Branch:   ${item.branch} (head: ${(item.headSha || "").slice(0, 10)})`);
    console.log(`URL:      ${item.prUrl}`);
    if (item.scores && item.scores.length > 0) {
      console.log(`Scores:   ${item.scores.map(s => `${s.lens || s.name || "score"}=${s.score ?? s}`).join(" | ")}`);
    }
    if (item.visual) {
      const diff = item.visual.diffPct !== undefined ? `${Number(item.visual.diffPct).toFixed(2)}%` : "n/a";
      console.log(`Visual:   diff=${diff}, consoleErr=${item.visual.consoleErrors ?? 0}, a11yBlocker=${item.visual.a11yBlocker ?? false}`);
    }
    console.log(`Merge:    node scripts/review-queue.mjs --merge ${item.repo}#${item.prNumber}`);
  }
  console.log(`------------------------------------------------------------\n`);
}

main().catch((err) => {
  console.error("Error running review-queue CLI:", err);
  process.exit(1);
});
