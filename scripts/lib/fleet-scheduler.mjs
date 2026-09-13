/**
 * Pure scheduling helpers for the repository fleet.
 *
 * The scheduler deliberately keeps its inputs and outputs JSON friendly.  It
 * does not perform GitHub calls, mutate history, or choose a model.  Callers
 * provide `now` and (when sampling upgrades) an optional deterministic `rng`.
 */

const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_SCORE = 1_000_000;
const MAX_AGE_DAYS = 3650;
const DEFAULT_REVIEW_ROLES = [
  "review",
  "tests",
  "security",
  "quality",
  "maintainer",
];

const DEFAULT_ALLOWED_OWNER = "M1Vj";
const OWNER_NAME_RE = /^[A-Za-z0-9_.-]+$/;

function finiteNumber(value, fallback = 0) {
  const number = typeof value === "number" ? value : Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function clamp(value, minimum = 0, maximum = 1) {
  const number = finiteNumber(value, minimum);
  return Math.min(maximum, Math.max(minimum, number));
}

function boundedScore(value) {
  return clamp(value, 0, MAX_SCORE);
}

function parseTime(value, fallback = Number.NaN) {
  if (value instanceof Date) {
    const timestamp = value.getTime();
    return Number.isFinite(timestamp) ? timestamp : fallback;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) return fallback;
    // Accept both JavaScript milliseconds and ordinary Unix seconds.
    return Math.abs(value) < 100_000_000_000 ? value * 1000 : value;
  }
  if (typeof value !== "string" || value.trim() === "") return fallback;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function resolveNow(value) {
  const parsed = parseTime(value);
  // Date can only represent roughly +/- 8.64e15 milliseconds.  Clamping the
  // accepted input keeps generatedAt and all derived arithmetic finite.
  return Number.isFinite(parsed) && Math.abs(parsed) <= 8.64e15 ? parsed : Date.now();
}

function ageDays(now, value, maximum = MAX_AGE_DAYS) {
  const timestamp = parseTime(value);
  if (!Number.isFinite(timestamp)) return maximum;
  return clamp((now - timestamp) / DAY_MS, 0, maximum);
}

function text(value) {
  return typeof value === "string" ? value.trim() : String(value ?? "").trim();
}

function key(value) {
  return text(value).toLowerCase();
}

function firstValue(...values) {
  for (const value of values) {
    if (value !== undefined && value !== null && value !== "") return value;
  }
  return undefined;
}

function truthyFlag(value) {
  if (value === true || value === 1) return true;
  const normalized = key(value);
  return normalized === "true" || normalized === "yes" || normalized === "y" || normalized === "on";
}

function repositoryReference(value) {
  if (value && typeof value === "object") {
    return text(firstValue(value.full_name, value.fullName, value.repoFullName, value.repo, value.name));
  }
  return text(value);
}

function allowedOwner(options = {}) {
  const configured = firstValue(options.allowedOwner, options.owner, options.githubOwner, DEFAULT_ALLOWED_OWNER);
  const owner = text(configured).split("/")[0];
  return OWNER_NAME_RE.test(owner) ? owner : DEFAULT_ALLOWED_OWNER;
}

function ownerPathAllowed(value, options = {}) {
  const reference = repositoryReference(value);
  const parts = reference.split("/");
  if (parts.length !== 2 || !OWNER_NAME_RE.test(parts[0]) || !OWNER_NAME_RE.test(parts[1])) return false;
  if (parts[0] === "." || parts[0] === ".." || parts[1] === "." || parts[1] === "..") return false;
  return key(parts[0]) === key(allowedOwner(options));
}

function repositoryName(repository) {
  if (!repository || typeof repository !== "object") return text(repository);
  return repositoryReference(firstValue(
    repository.full_name,
    repository.fullName,
    repository.repoFullName,
    repository.repo,
    repository.repository?.full_name,
    repository.repository?.fullName,
  ));
}

function pullRequestRepository(pullRequest) {
  if (!pullRequest || typeof pullRequest !== "object") return "";
  return repositoryReference(firstValue(
    pullRequest.repo,
    pullRequest.repository?.full_name,
    pullRequest.repository?.fullName,
    pullRequest.base?.repo?.full_name,
    pullRequest.base?.repo?.fullName,
    pullRequest.head?.repo?.full_name,
    pullRequest.head?.repo?.fullName,
    pullRequest.repoFullName,
  ));
}

function pullRequestNumber(pullRequest) {
  if (!pullRequest || typeof pullRequest !== "object") return undefined;
  const candidate = firstValue(
    pullRequest.number,
    pullRequest.pr,
    pullRequest.pullRequest?.number,
    pullRequest.pull_request?.number,
  );
  if (candidate === undefined) return undefined;
  const number = finiteNumber(candidate, Number.NaN);
  return Number.isFinite(number) ? number : text(candidate);
}

function asList(value) {
  if (Array.isArray(value)) return value;
  if (value instanceof Set) return [...value];
  if (typeof value === "string") {
    return value
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean);
  }
  return value === undefined || value === null ? [] : [value];
}

function listContains(list, name) {
  const wanted = key(name);
  if (!wanted) return false;
  if (list && typeof list === "object" && !Array.isArray(list) && !(list instanceof Set)) {
    for (const [candidate, value] of Object.entries(list)) {
      if (key(candidate) === wanted && value !== false && value !== null && value !== undefined) return true;
    }
  }
  return asList(list).some((item) => {
    if (item && typeof item === "object") {
      return key(firstValue(item.full_name, item.fullName, item.repo, item.name)) === wanted;
    }
    return key(item) === wanted;
  });
}

function manualRepositoryConfig(repository, options) {
  const targets = options?.targets && typeof options.targets === "object" ? options.targets : {};
  const sources = [
    targets.manual,
    targets.repositories,
    options?.manual,
    options?.repositoryConfig,
    options?.repoConfig,
  ];
  const wanted = key(repositoryName(repository));
  for (const source of sources) {
    if (!source || typeof source !== "object" || Array.isArray(source)) continue;
    for (const [candidate, config] of Object.entries(source)) {
      if (key(candidate) === wanted && config && typeof config === "object") return config;
    }
  }
  return {};
}

function isExcludedRepository(repository, options = {}) {
  const name = repositoryName(repository);
  const targets = options.targets && typeof options.targets === "object" ? options.targets : {};
  const excluded = firstValue(targets.excluded, options.excluded, options.excludedRepos, options.exclude);
  const manual = manualRepositoryConfig(repository, options);
  return Boolean(
    truthyFlag(repository?.archived) ||
    truthyFlag(repository?.fork) ||
    truthyFlag(repository?.excluded) ||
    truthyFlag(manual.excluded) ||
    listContains(excluded, name),
  );
}

function repositoryTargetFlags(repository, options = {}) {
  const targets = options.targets && typeof options.targets === "object" ? options.targets : {};
  const manual = manualRepositoryConfig(repository, options);
  const name = repositoryName(repository);
  const tierValue = firstValue(repository?.tier, repository?.manualTier, manual.tier, manual.level);
  const tier1 = Boolean(
    listContains(targets.tier1, name) ||
    listContains(options.tier1, name) ||
    manual.tier1 === true ||
    key(tierValue) === "tier1" ||
    key(tierValue) === "1" ||
    finiteNumber(tierValue, 0) === 1,
  );
  const priorityValue = firstValue(repository?.priority, repository?.manualPriority, manual.priority);
  const priority = Boolean(
    listContains(targets.priority, name) ||
    listContains(options.priority, name) ||
    manual.priority === true ||
    key(priorityValue) === "high" ||
    key(priorityValue) === "urgent" ||
    key(priorityValue) === "priority" ||
    finiteNumber(priorityValue, 0) > 0,
  );
  const manualWeight = clamp(
    firstValue(
      repository?.manualWeight,
      repository?.schedulerWeight,
      manual.weight,
      manual.score,
      manual.importance,
      options.manualWeight,
    ),
    0,
    10,
  );
  return { tier1, priority, manualWeight };
}

function latestTimestamp(values) {
  let latest = Number.NaN;
  for (const value of values) {
    const timestamp = parseTime(value);
    if (Number.isFinite(timestamp) && (!Number.isFinite(latest) || timestamp > latest)) latest = timestamp;
  }
  return latest;
}

function historyRepository(entry) {
  return repositoryReference(firstValue(
    entry?.repo,
    entry?.repository,
    entry?.repoFullName,
    entry?.repo_full_name,
    entry?.repository?.full_name,
    entry?.repository?.fullName,
  ));
}

function historyPullRequest(entry) {
  const candidate = firstValue(
    entry?.pr,
    entry?.pullRequest,
    entry?.pull_request,
    entry?.number,
    entry?.prNumber,
    entry?.pullRequestNumber,
  );
  if (candidate === undefined || candidate === null || candidate === "") return undefined;
  const number = finiteNumber(candidate, Number.NaN);
  return Number.isFinite(number) ? number : text(candidate);
}

function historyTime(entry) {
  return latestTimestamp([
    entry?.lastSelectedAt,
    entry?.selectedAt,
    entry?.lastVisitedAt,
    entry?.visitedAt,
    entry?.lastSelected,
    entry?.selected_at,
    entry?.last_selected_at,
    entry?.lastVisited,
    entry?.visited_at,
    entry?.last_visited_at,
    entry?.lastRunAt,
    entry?.last_run_at,
    entry?.at,
    entry?.timestamp,
    entry?.t,
  ]);
}

function matchingHistory(repository, history = []) {
  const wanted = key(repository);
  if (!wanted || !Array.isArray(history)) return [];
  return history.filter((entry) => key(historyRepository(entry)) === wanted);
}

function repositoryHistoryDetails(repository, history, now) {
  const entries = matchingHistory(repositoryName(repository), history);
  const latest = latestTimestamp(entries.map(historyTime));
  const selectedAgeDays = Number.isFinite(latest) ? ageDays(now, latest) : MAX_AGE_DAYS;
  const hasHistory = entries.length > 0 && Number.isFinite(latest);
  // Fairness grows with time since a repository was selected.  Cooldown is a
  // soft multiplier: a just-selected repository is less likely, never barred.
  const fairness = hasHistory ? clamp(0.75 + selectedAgeDays / 45, 0.75, 5) : 1.25;
  const cooldown = hasHistory ? clamp(0.15 + selectedAgeDays / 2, 0.15, 1) : 1;
  return { hasHistory, selectedAgeDays, fairness, cooldown };
}

function repositoryActivityDetails(repository, now) {
  const activityAt = latestTimestamp([
    repository?.pushed_at,
    repository?.pushedAt,
    repository?.updated_at,
    repository?.updatedAt,
    repository?.last_activity_at,
    repository?.lastActivityAt,
    repository?.last_push,
    repository?.lastPush,
    repository?.activity_at,
    repository?.activityAt,
  ]);
  const activityAgeDays = Number.isFinite(activityAt) ? ageDays(now, activityAt) : MAX_AGE_DAYS;
  const createdAt = firstValue(repository?.created_at, repository?.createdAt);
  const repositoryAgeDays = ageDays(now, createdAt);
  return {
    activityAgeDays,
    repositoryAgeDays,
    recency: Number.isFinite(activityAt) ? Math.exp(-activityAgeDays / 30) : 0,
    newness: Number.isFinite(parseTime(createdAt)) ? Math.exp(-repositoryAgeDays / 90) : 0,
  };
}

function numericCount(...values) {
  for (const value of values) {
    if (Array.isArray(value)) return value.length;
    const count = finiteNumber(value, Number.NaN);
    if (Number.isFinite(count)) return Math.max(0, count);
  }
  return 0;
}

function repositoryBacklog(repository) {
  const nested = repository?.backlog && typeof repository.backlog === "object" ? repository.backlog : {};
  const count = numericCount(
    repository?.backlog,
    repository?.backlogCount,
    repository?.open_issues_count,
    repository?.openIssuesCount,
    repository?.open_issues,
    repository?.openIssues,
    repository?.open_pr_count,
    repository?.openPrCount,
    repository?.open_pull_requests,
    repository?.openPullRequests,
    repository?.open_prs,
    repository?.openPrs,
    repository?.pending,
    repository?.pendingCount,
    repository?.issues,
    repository?.pullRequests,
    repository?.backlogSize,
    nested.count,
    nested.open,
  );
  return clamp(Math.log1p(count) / Math.log1p(100), 0, 1);
}

function repositoryCiRisk(repository) {
  const ci = repository?.ci && typeof repository.ci === "object" ? repository.ci : {};
  const status = key(firstValue(
    repository?.ci_status,
    repository?.ciStatus,
    repository?.checks_status,
    repository?.checksStatus,
    ci.status,
    ci.conclusion,
  ));
  const failures = numericCount(
    repository?.ci_failures,
    repository?.ciFailures,
    repository?.failed_workflows,
    repository?.failedWorkflows,
    repository?.workflow_failures,
    repository?.workflowFailures,
    repository?.failing_checks,
    repository?.failingChecks,
    repository?.ci_failed,
    repository?.ciFailed,
    repository?.workflowRuns?.failed,
    repository?.checks?.failed,
    ci.failures,
    ci.failed,
  );
  const statusRisk = /fail|error|red|unstable|cancel/.test(status) ? 1 : 0;
  return clamp(Math.max(statusRisk, Math.log1p(failures) / Math.log1p(10)), 0, 1);
}

function repositoryImportance(repository) {
  const raw = finiteNumber(firstValue(
    repository?.importance,
    repository?.importanceScore,
    repository?.criticality,
    repository?.importance_weight,
    repository?.importanceWeight,
    repository?.critical,
    repository?.stargazers_count,
    repository?.stars,
    repository?.watchers_count,
  ), 0);
  if (raw <= 0) return 0;
  return raw <= 1 ? clamp(raw, 0, 1) : clamp(Math.log1p(raw) / Math.log1p(1000), 0, 1);
}

function repositoryScoreDetails(repository, options = {}) {
  const now = resolveNow(options.now);
  const targetFlags = repositoryTargetFlags(repository, options);
  const activity = repositoryActivityDetails(repository, now);
  const backlog = repositoryBacklog(repository);
  const ciRisk = repositoryCiRisk(repository);
  const importance = repositoryImportance(repository);
  const fairness = repositoryHistoryDetails(repository, options.history, now);
  const eligible = ownerPathAllowed(repository, options) && !isExcludedRepository(repository, options);
  const factors = {
    base: 1,
    tier1: targetFlags.tier1 ? 6 : 0,
    priority: targetFlags.priority ? 4 : 0,
    manual: targetFlags.manualWeight,
    recency: 3 * activity.recency,
    newness: 2 * activity.newness,
    importance: 2 * importance,
    backlog: 2 * backlog,
    ci: 2 * ciRisk,
    fairness: fairness.fairness,
    cooldown: fairness.cooldown,
    activityAgeDays: activity.activityAgeDays,
    repositoryAgeDays: activity.repositoryAgeDays,
    selectedAgeDays: fairness.selectedAgeDays,
    eligible,
  };
  if (!eligible) return { score: 0, factors };
  const additive = factors.base + factors.tier1 + factors.priority + factors.manual + factors.recency + factors.newness + factors.importance + factors.backlog + factors.ci;
  return { score: boundedScore(additive * factors.fairness * factors.cooldown), factors };
}

/** Return a finite, bounded scheduling weight for a repository. */
export function scoreRepository(repository, options = {}) {
  return repositoryScoreDetails(repository || {}, options).score;
}

function rowWeight(row) {
  if (row && typeof row === "object") {
    return Math.max(0, finiteNumber(firstValue(row.weight, row.score, row.priority), 0));
  }
  return 1;
}

function safeRandom(rng) {
  let value;
  try {
    value = typeof rng === "function" ? rng() : 0.5;
  } catch {
    value = 0.5;
  }
  return clamp(value, 0, 1 - Number.EPSILON);
}

/**
 * Weighted roulette-wheel sampling without replacement.  Rows are returned
 * by reference in their sampled order and are never selected twice.
 */
export function weightedSampleWithoutReplacement(rows, count, rng = () => 0.5) {
  if (!Array.isArray(rows) || rows.length === 0) return [];
  const wanted = Math.min(rows.length, Math.max(0, Math.floor(finiteNumber(count, 0))));
  if (wanted === 0) return [];
  const remaining = rows.map((row, index) => ({ row, index, weight: rowWeight(row) }));
  const selected = [];
  while (selected.length < wanted && remaining.length > 0) {
    const total = remaining.reduce((sum, item) => sum + item.weight, 0);
    const random = safeRandom(rng);
    let chosenIndex = 0;
    if (total > 0 && Number.isFinite(total)) {
      let target = random * total;
      for (let index = 0; index < remaining.length; index += 1) {
        target -= remaining[index].weight;
        if (target < 0 || index === remaining.length - 1) {
          chosenIndex = index;
          break;
        }
      }
    } else {
      chosenIndex = Math.min(remaining.length - 1, Math.floor(random * remaining.length));
    }
    selected.push(remaining[chosenIndex].row);
    remaining.splice(chosenIndex, 1);
  }
  return selected;
}

function pullHistoryDetails(pullRequest, history, now) {
  const repo = pullRequestRepository(pullRequest);
  const number = pullRequestNumber(pullRequest);
  const entries = matchingHistory(repo, history);
  const exact = entries.filter((entry) => {
    const entryNumber = historyPullRequest(entry);
    return entryNumber !== undefined && number !== undefined && String(entryNumber) === String(number);
  });
  const candidates = exact.length > 0 ? exact : entries;
  const visitedAt = latestTimestamp(candidates.map(historyTime));
  return {
    visited: Number.isFinite(visitedAt),
    sinceVisitDays: Number.isFinite(visitedAt) ? ageDays(now, visitedAt) : MAX_AGE_DAYS,
  };
}

function triggerMatchesPullRequest(trigger, pullRequest) {
  if (!trigger || typeof trigger !== "object") return false;
  const triggerRepo = repositoryReference(firstValue(
    trigger.repo,
    trigger.repository,
    trigger.repoFullName,
    trigger.pull_request?.base?.repo?.full_name,
    trigger.pull_request?.base?.repo?.fullName,
    trigger.pull_request?.repository?.full_name,
    trigger.pull_request?.repository?.fullName,
    trigger.pullRequest?.repository?.full_name,
    trigger.pullRequest?.repository?.fullName,
  ));
  const triggerNumber = firstValue(
    trigger.number,
    trigger.pr,
    trigger.pull_request?.number,
    trigger.pullRequest?.number,
  );
  const repo = pullRequestRepository(pullRequest);
  const number = pullRequestNumber(pullRequest);
  const repoMatches = !triggerRepo || key(triggerRepo) === key(repo);
  const numberMatches = triggerNumber === undefined || String(triggerNumber) === String(number);
  const event = key(firstValue(trigger.event, trigger.type, trigger.kind));
  const eventMatches = event === "" || event === "pull_request" || event === "pull_request_target" || event === "pullrequest" || event.startsWith("pull_request.");
  return repoMatches && numberMatches && eventMatches;
}

function pullRequestScoreDetails(pullRequest, options = {}) {
  const now = resolveNow(options.now);
  const state = key(firstValue(pullRequest?.state, pullRequest?.status, "open"));
  const open = state === "open" || state === "";
  const ageAt = firstValue(pullRequest?.created_at, pullRequest?.createdAt, pullRequest?.opened_at, pullRequest?.openedAt);
  const age = ageDays(now, ageAt);
  const historyDetails = pullHistoryDetails(pullRequest || {}, options.history, now);
  const triggered = triggerMatchesPullRequest(options.trigger, pullRequest || {});
  const labels = asList(pullRequest?.labels).map((label) => key(label?.name ?? label));
  const explicitPriority = Boolean(
    pullRequest?.priority === true ||
    pullRequest?.urgent === true ||
    labels.some((label) => /urgent|priority|security|hotfix/.test(label)),
  );
  const ownerEligible = ownerPathAllowed(pullRequestRepository(pullRequest), options);
  const factors = {
    base: 1,
    age: 1 + clamp(age / 30, 0, 12),
    sinceVisit: 1 + clamp(historyDetails.sinceVisitDays / 30, 0, 12),
    trigger: triggered ? 8 : 1,
    priority: explicitPriority ? 2 : 1,
    ageDays: age,
    sinceVisitDays: historyDetails.sinceVisitDays,
    triggered,
    eligible: open && ownerEligible,
  };
  if (!open || !ownerEligible) return { score: 0, factors };
  return {
    score: boundedScore(factors.base * factors.age * factors.sinceVisit * factors.trigger * factors.priority),
    factors,
  };
}

/** Return a finite scheduling weight for an open pull request. */
export function scorePullRequest(pullRequest, options = {}) {
  return pullRequestScoreDetails(pullRequest || {}, options).score;
}

function pullRequestKey(pullRequest, fallbackIndex = 0) {
  const repo = key(pullRequestRepository(pullRequest));
  const number = pullRequestNumber(pullRequest);
  return `${repo}#${number === undefined ? `row-${fallbackIndex}` : number}`;
}

function repositoryMetadataMap(repositories) {
  const map = new Map();
  for (const repository of Array.isArray(repositories) ? repositories : []) {
    const name = key(repositoryName(repository));
    if (name) map.set(name, repository);
  }
  return map;
}

function pullRepositoryEligible(pullRequest, repositoryMap, options) {
  const repoName = pullRequestRepository(pullRequest);
  const metadata = repositoryMap.get(key(repoName)) || pullRequest?.repository || {};
  return ownerPathAllowed(repoName, options) && !isExcludedRepository({ ...metadata, full_name: repoName }, options);
}

function triggerPullRequest(input) {
  const trigger = input?.trigger;
  if (!trigger || typeof trigger !== "object") return null;
  const candidate = trigger.pull_request || trigger.pullRequest;
  if (!candidate || typeof candidate !== "object") return null;
  const repo = pullRequestRepository(candidate) || repositoryReference(firstValue(trigger.repo, trigger.repository, trigger.repoFullName));
  return { ...candidate, ...(repo && !candidate.repo ? { repo } : {}) };
}

function roleList(input) {
  const requested = firstValue(input?.reviewRoles, input?.roles, input?.agentRoles);
  const values = asList(requested).map((role) => text(role)).filter(Boolean);
  const roles = values.length > 0 ? values : DEFAULT_REVIEW_ROLES;
  return [...new Set(roles)].slice(0, 12);
}

function taskForPullRequest(pullRequest, score, factors, role, triggered) {
  const repo = pullRequestRepository(pullRequest);
  const number = pullRequestNumber(pullRequest);
  return {
    kind: "pull_request",
    type: "review",
    action: "review",
    repo,
    repository: repo,
    repoFullName: repo,
    pr: number,
    number,
    pullRequest,
    pull_request: pullRequest,
    role,
    reviewRole: role,
    roles: [role],
    reviewRoles: [role],
    score: boundedScore(score),
    scoreFactors: factors,
    triggered: Boolean(triggered),
  };
}

function taskForUpgrade(repository, score, factors) {
  const repo = repositoryName(repository);
  return {
    kind: "upgrade",
    type: "upgrade",
    action: "upgrade",
    role: "upgrade",
    reviewRole: "upgrade",
    repo,
    repository: repo,
    repoFullName: repo,
    score: boundedScore(score),
    scoreFactors: factors,
  };
}

/**
 * Build a bounded, deterministic plan. Triggered PR review lanes are placed
 * first, then a soft minimum of upgrade lanes is reserved so an old PR
 * backlog cannot starve repository maintenance. Remaining capacity is filled
 * by other open PRs, with additional upgrades used only when that backlog is
 * smaller than the available capacity.
 */
export function buildFleetPlan(input = {}) {
  const repositories = Array.isArray(input.repos) ? input.repos : (Array.isArray(input.repositories) ? input.repositories : []);
  const pulls = Array.isArray(input.pulls) ? input.pulls : (Array.isArray(input.pullRequests) ? input.pullRequests : []);
  const history = Array.isArray(input.history) ? input.history : [];
  const now = resolveNow(input.now);
  const options = { ...input, history, now };
  const repositoryMap = repositoryMetadataMap(repositories);
  const eligibleRepositories = [];
  const seenRepositories = new Set();
  for (const repository of repositories) {
    const name = key(repositoryName(repository));
    if (!name || seenRepositories.has(name) || isExcludedRepository(repository, options)) continue;
    seenRepositories.add(name);
    eligibleRepositories.push(repository);
  }
  const triggeredPull = triggerPullRequest(input);
  const allPulls = triggeredPull ? [...pulls, triggeredPull] : pulls;
  const uniquePulls = [];
  const seenPulls = new Set();
  for (let index = 0; index < allPulls.length; index += 1) {
    const pullRequest = allPulls[index];
    if (!pullRequest || typeof pullRequest !== "object") continue;
    const id = pullRequestKey(pullRequest, index);
    if (seenPulls.has(id)) continue;
    seenPulls.add(id);
    if (!pullRepositoryEligible(pullRequest, repositoryMap, options)) continue;
    const details = pullRequestScoreDetails(pullRequest, options);
    if (details.score <= 0) continue;
    uniquePulls.push({ pullRequest, details, triggered: triggerMatchesPullRequest(input.trigger, pullRequest) });
  }
  uniquePulls.sort((a, b) => {
    if (a.triggered !== b.triggered) return a.triggered ? -1 : 1;
    if (b.details.score !== a.details.score) return b.details.score - a.details.score;
    const repoCompare = key(pullRequestRepository(a.pullRequest)).localeCompare(key(pullRequestRepository(b.pullRequest)));
    if (repoCompare !== 0) return repoCompare;
    return finiteNumber(pullRequestNumber(a.pullRequest), 0) - finiteNumber(pullRequestNumber(b.pullRequest), 0);
  });

  const maxAgentsRaw = finiteNumber(firstValue(input.maxAgents, input.max_agents), Number.MAX_SAFE_INTEGER);
  const maxAgents = Math.min(Number.MAX_SAFE_INTEGER, Math.max(0, Math.floor(maxAgentsRaw)));
  const agentsPerPr = Math.min(12, Math.max(1, Math.floor(finiteNumber(firstValue(input.agentsPerPr, input.agents_per_pr), 1))));
  const roles = roleList(input);
  const eventTasks = [];
  const eventPulls = uniquePulls.filter((entry) => entry.triggered);
  const ordinaryPulls = uniquePulls.filter((entry) => !entry.triggered);

  // Give every triggered PR a small multi-role burst before ordinary work.
  for (const entry of eventPulls) {
    for (let roleIndex = 0; roleIndex < Math.min(agentsPerPr, roles.length) && eventTasks.length < maxAgents; roleIndex += 1) {
      eventTasks.push(taskForPullRequest(entry.pullRequest, entry.details.score, entry.details.factors, roles[roleIndex], true));
    }
  }
  // One lane per other PR preserves breadth and keeps old open PRs eligible.
  const upgradeRows = eligibleRepositories
    .map((repository) => {
      const details = repositoryScoreDetails(repository, options);
      return { repository, score: details.score, weight: details.score, factors: details.factors };
    })
    .filter((row) => row.score > 0)
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      return key(repositoryName(a.repository)).localeCompare(key(repositoryName(b.repository)));
    });
  // An omitted upgradeSlots value means upgrades are allowed up to the plan
  // capacity. An explicit zero still disables them (useful for event-only
  // runs). The reservation is intentionally soft and bounded by all of the
  // caller's limits and by the number of eligible repositories.
  const upgradeSlotsInput = firstValue(input.upgradeSlots, input.upgrade_slots);
  const upgradeSlotLimit = Math.min(
    upgradeRows.length,
    Math.max(0, Math.floor(finiteNumber(upgradeSlotsInput, maxAgents))),
    Math.max(0, maxAgents - eventTasks.length),
  );
  const minimumUpgradeInput = firstValue(
    input.minimumUpgradeSlots,
    input.minimum_upgrade_slots,
    input.reservedUpgradeSlots,
    input.reserved_upgrade_slots,
  );
  const minimumUpgradeSlots = Math.min(
    upgradeSlotLimit,
    Math.max(0, Math.floor(finiteNumber(minimumUpgradeInput, 3))),
  );
  const sampledUpgrades = weightedSampleWithoutReplacement(upgradeRows, upgradeSlotLimit, input.rng);
  const upgrades = sampledUpgrades
    .slice(0, minimumUpgradeSlots)
    .map((row) => taskForUpgrade(row.repository, row.score, row.factors));

  const ordinaryTasks = [];
  const ordinaryCapacity = Math.max(0, maxAgents - eventTasks.length - upgrades.length);
  for (const entry of ordinaryPulls) {
    if (ordinaryTasks.length >= ordinaryCapacity) break;
    ordinaryTasks.push(taskForPullRequest(entry.pullRequest, entry.details.score, entry.details.factors, roles[0], false));
  }

  // Preserve the historical behavior of using additional upgrade slots when
  // there are fewer ordinary PRs than the remaining capacity, while keeping
  // the minimum reservation effective when the backlog is large.
  const additionalUpgradeCapacity = Math.min(
    Math.max(0, sampledUpgrades.length - upgrades.length),
    Math.max(0, maxAgents - eventTasks.length - ordinaryTasks.length - upgrades.length),
  );
  for (const row of sampledUpgrades.slice(upgrades.length, upgrades.length + additionalUpgradeCapacity)) {
    upgrades.push(taskForUpgrade(row.repository, row.score, row.factors));
  }

  const tasks = [...eventTasks, ...ordinaryTasks];

  return {
    tasks,
    upgrades,
    allTasks: [...eventTasks, ...upgrades, ...ordinaryTasks],
    totalAgents: tasks.length + upgrades.length,
    maxAgents,
    generatedAt: new Date(now).toISOString(),
  };
}
