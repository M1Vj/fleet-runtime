/**
 * ============================================================================
 * FLEET PERSISTENT MEMORY SYSTEM (ACID SQLite WAL)
 * ============================================================================
 * Provides institutional memory across runs, workflows, and cloud runners:
 * 1. Storage: SQLite WAL mode with 5000ms busy timeout.
 * 2. Mistakes Ledger: Records error signatures, failure descriptions, and proven fixes.
 * 3. Repo Memory: Stores conventions, verified test/build commands, and learnings.
 * 4. System Prompt Block: Generates structured XML blocks (<persistent_cross_session_memory>)
 *    for automatic prompt injection in model.mjs.
 * ============================================================================
 */

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

let DatabaseSync = null;
try {
  const sqlite = await import("node:sqlite");
  DatabaseSync = sqlite.DatabaseSync;
} catch {
  DatabaseSync = null;
}

let _dbInstance = null;
let _fallbackStore = null;

function resolveDbPath(env = process.env) {
  if (env.FLEET_MEMORY_DB) return env.FLEET_MEMORY_DB;
  if (env.OPENCODE_MEMORY_DB) return env.OPENCODE_MEMORY_DB;
  const root = env.FLEET_STATE_ROOT || process.cwd();
  return path.join(root, "state", "fleet-memory.db");
}

export function getDb(env = process.env) {
  if (_dbInstance) return _dbInstance;
  const dbPath = resolveDbPath(env);

  if (!DatabaseSync) {
    if (!_fallbackStore) {
      _fallbackStore = {
        mistakes: new Map(),
        repo_memory: new Map(),
        fleet_memory: new Map(),
      };
    }
    return null;
  }

  if (dbPath !== ":memory:") {
    const dir = path.dirname(dbPath);
    if (!fs.existsSync(dir)) {
      try { fs.mkdirSync(dir, { recursive: true }); } catch {}
    }
  }

  const db = new DatabaseSync(dbPath);
  try {
    db.exec("PRAGMA journal_mode = WAL;");
    db.exec("PRAGMA busy_timeout = 5000;");
    db.exec("PRAGMA synchronous = NORMAL;");
  } catch {}

  db.exec(`
    CREATE TABLE IF NOT EXISTS mistakes (
      id TEXT PRIMARY KEY,
      error_signature TEXT NOT NULL,
      mistake_description TEXT NOT NULL,
      correct_fix TEXT NOT NULL,
      repo TEXT NOT NULL,
      tags TEXT,
      occurrences INTEGER DEFAULT 1,
      created_at TEXT NOT NULL,
      last_seen_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_mistakes_repo ON mistakes(repo);
    CREATE INDEX IF NOT EXISTS idx_mistakes_sig ON mistakes(error_signature);

    CREATE TABLE IF NOT EXISTS fleet_memory (
      category TEXT NOT NULL,
      key TEXT NOT NULL,
      value TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (category, key)
    );

    CREATE TABLE IF NOT EXISTS repo_memory (
      slug TEXT PRIMARY KEY,
      path TEXT NOT NULL,
      last_updated TEXT NOT NULL,
      tech_stack TEXT,
      conventions TEXT,
      test_commands TEXT,
      build_commands TEXT,
      architectural_notes TEXT,
      recent_learnings TEXT
    );
  `);

  _dbInstance = db;
  return db;
}

export function closeDb() {
  if (_dbInstance) {
    try { _dbInstance.close(); } catch {}
    _dbInstance = null;
  }
  _fallbackStore = null;
}

export function getRepoSlug(repoPath = process.cwd()) {
  try {
    const resolved = path.resolve(repoPath);
    return path.basename(resolved).replace(/[^a-zA-Z0-9._-]/g, "_").toLowerCase();
  } catch {
    return "global";
  }
}

// ----------------------------------------------------------------------------
// Mistakes Ledger Management
// ----------------------------------------------------------------------------

export function recordMistake({
  errorSignature,
  mistakeDescription,
  correctFix,
  repo = "global",
  tags = [],
}, env = process.env) {
  if (!errorSignature || !mistakeDescription || !correctFix) return false;
  const db = getDb(env);
  const id = crypto.createHash("sha256").update(`${errorSignature}:${mistakeDescription}`).digest("hex").slice(0, 16);
  const now = new Date().toISOString();
  const cleanTags = Array.from(new Set(tags || []));

  if (!db) {
    const existing = _fallbackStore.mistakes.get(id);
    if (existing) {
      existing.occurrences++;
      existing.lastSeenAt = now;
      existing.correctFix = correctFix;
    } else {
      _fallbackStore.mistakes.set(id, {
        id, errorSignature, mistakeDescription, correctFix, repo, tags: cleanTags,
        occurrences: 1, createdAt: now, lastSeenAt: now,
      });
    }
    return true;
  }

  const existing = db.prepare("SELECT occurrences, tags FROM mistakes WHERE id = ? OR error_signature = ?").get(id, errorSignature);

  if (existing) {
    let mergedTags = cleanTags;
    try {
      mergedTags = Array.from(new Set([...JSON.parse(existing.tags || "[]"), ...cleanTags]));
    } catch {}
    const update = db.prepare(`
      UPDATE mistakes SET
        occurrences = occurrences + 1,
        last_seen_at = ?,
        mistake_description = ?,
        correct_fix = ?,
        repo = ?,
        tags = ?
      WHERE id = ? OR error_signature = ?
    `);
    update.run(now, mistakeDescription, correctFix, repo, JSON.stringify(mergedTags), id, errorSignature);
  } else {
    const insert = db.prepare(`
      INSERT INTO mistakes (id, error_signature, mistake_description, correct_fix, repo, tags, occurrences, created_at, last_seen_at)
      VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)
    `);
    insert.run(id, errorSignature, mistakeDescription, correctFix, repo, JSON.stringify(cleanTags), now, now);
  }

  return true;
}

export function listMistakes({ repo = null, query = null, limit = 20, exactRepo = false } = {}, env = process.env) {
  const db = getDb(env);
  if (!db) {
    let results = Array.from(_fallbackStore.mistakes.values());
    if (repo && repo !== "global") {
      results = results.filter((m) => exactRepo ? m.repo === repo : (m.repo === repo || m.repo === "global"));
    }
    if (query) {
      const qLower = query.toLowerCase();
      results = results.filter((m) =>
        m.errorSignature.toLowerCase().includes(qLower) ||
        m.mistakeDescription.toLowerCase().includes(qLower) ||
        m.correctFix.toLowerCase().includes(qLower)
      );
    }
    return results.slice(0, limit);
  }

  let sql = "SELECT * FROM mistakes WHERE 1=1";
  const params = [];

  if (repo && repo !== "global") {
    if (exactRepo) {
      sql += " AND repo = ?";
      params.push(repo);
    } else {
      sql += " AND (repo = ? OR repo = 'global')";
      params.push(repo);
    }
  }

  sql += " ORDER BY last_seen_at DESC LIMIT ?";
  params.push(limit * 3);

  const rows = db.prepare(sql).all(...params);
  let results = rows.map((r) => ({
    id: r.id,
    errorSignature: r.error_signature,
    mistakeDescription: r.mistake_description,
    correctFix: r.correct_fix,
    repo: r.repo,
    tags: JSON.parse(r.tags || "[]"),
    occurrences: r.occurrences,
    createdAt: r.created_at,
    lastSeenAt: r.last_seen_at,
  }));

  if (query) {
    const qLower = query.toLowerCase();
    results = results.filter((m) =>
      m.errorSignature.toLowerCase().includes(qLower) ||
      m.mistakeDescription.toLowerCase().includes(qLower) ||
      m.correctFix.toLowerCase().includes(qLower) ||
      (m.tags && m.tags.some((t) => t.toLowerCase().includes(qLower)))
    );
  }

  return results.slice(0, limit);
}

// ----------------------------------------------------------------------------
// Fleet Memory Management
// ----------------------------------------------------------------------------

export function getFleetMemory(env = process.env) {
  const db = getDb(env);
  if (!db) return { version: 2, crossRepoKnowledge: {} };

  const rows = db.prepare("SELECT category, key, value, updated_at FROM fleet_memory").all();
  const crossRepoKnowledge = {};

  for (const r of rows) {
    if (!crossRepoKnowledge[r.category]) crossRepoKnowledge[r.category] = {};
    let val = r.value;
    try { val = JSON.parse(r.value); } catch {}
    crossRepoKnowledge[r.category][r.key] = {
      value: val,
      updatedAt: r.updated_at,
    };
  }

  return {
    version: 2,
    storage: "sqlite-wal",
    lastUpdated: new Date().toISOString(),
    invariants: [
      "Zero Gemini models anywhere in code, workflows, or model chains.",
      "Universal commit authorship Vj <143296579+M1Vj@users.noreply.github.com>.",
      "Always supply email in GitHub Contents API PUT author and committer objects.",
    ],
    crossRepoKnowledge,
  };
}

export function storeFleetKnowledge(key, value, category = "general", env = process.env) {
  const db = getDb(env);
  const now = new Date().toISOString();
  const valStr = typeof value === "object" ? JSON.stringify(value) : String(value);

  if (!db) return true;

  const stmt = db.prepare(`
    INSERT INTO fleet_memory (category, key, value, updated_at)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(category, key) DO UPDATE SET
      value = excluded.value,
      updated_at = excluded.updated_at
  `);
  stmt.run(category, key, valStr, now);
  return true;
}

// ----------------------------------------------------------------------------
// Repository Memory Management & Markdown Sync
// ----------------------------------------------------------------------------

export function parseMemoryMarkdown(content) {
  const result = {
    techStack: [],
    conventions: [],
    testCommands: [],
    buildCommands: [],
    architecturalNotes: [],
    recentLearnings: [],
  };

  if (!content || typeof content !== "string") return result;

  const lines = content.split("\n");
  let currentSection = null;

  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith("## ")) {
      const heading = trimmed.slice(3).toLowerCase();
      if (heading.includes("tech") || heading.includes("stack")) currentSection = "techStack";
      else if (heading.includes("convention")) currentSection = "conventions";
      else if (heading.includes("test")) currentSection = "testCommands";
      else if (heading.includes("build")) currentSection = "buildCommands";
      else if (heading.includes("command")) currentSection = "testCommands";
      else if (heading.includes("architect")) currentSection = "architecturalNotes";
      else if (heading.includes("learning")) currentSection = "recentLearnings";
      else currentSection = null;
      continue;
    }

    if (currentSection && (trimmed.startsWith("- ") || trimmed.startsWith("* "))) {
      let item = trimmed.slice(2).trim();
      if (item.startsWith("`") && item.endsWith("`") && item.length > 2) {
        item = item.slice(1, -1);
      }
      if (currentSection === "testCommands" && item.toLowerCase().startsWith("**test**:")) {
        item = item.replace(/^\*\*test\*\*:\s*/i, "").trim();
        if (item.startsWith("`") && item.endsWith("`") && item.length > 2) item = item.slice(1, -1);
      } else if (item.toLowerCase().startsWith("**build**:")) {
        const buildItem = item.replace(/^\*\*build\*\*:\s*/i, "").trim();
        const cleanBuild = buildItem.startsWith("`") && buildItem.endsWith("`") && buildItem.length > 2 ? buildItem.slice(1, -1) : buildItem;
        if (!result.buildCommands.includes(cleanBuild)) result.buildCommands.push(cleanBuild);
        continue;
      }
      if (item && !result[currentSection].includes(item)) {
        result[currentSection].push(item);
      }
    }
  }

  return result;
}

export function formatMemoryMarkdown(memory, slug = "repo") {
  const sections = [];
  sections.push(`# Repository Memory (${slug})\n`);
  sections.push(`> Persistent memory maintained across sessions, subagents, and fleet runs.\n`);

  if (memory.techStack?.length > 0) {
    sections.push(`## Tech Stack`);
    for (const t of memory.techStack) sections.push(`- ${t}`);
    sections.push("");
  }

  if (memory.conventions?.length > 0) {
    sections.push(`## Conventions`);
    for (const c of memory.conventions) sections.push(`- ${c}`);
    sections.push("");
  }

  if (memory.testCommands?.length > 0 || memory.buildCommands?.length > 0) {
    sections.push(`## Verified Commands`);
    if (memory.testCommands?.length > 0) {
      for (const cmd of memory.testCommands) sections.push(`- **Test**: \`${cmd}\``);
    }
    if (memory.buildCommands?.length > 0) {
      for (const cmd of memory.buildCommands) sections.push(`- **Build**: \`${cmd}\``);
    }
    sections.push("");
  }

  if (memory.architecturalNotes?.length > 0) {
    sections.push(`## Architectural Notes`);
    for (const note of memory.architecturalNotes) sections.push(`- ${note}`);
    sections.push("");
  }

  if (memory.recentLearnings?.length > 0) {
    sections.push(`## Recent Learnings`);
    for (const l of memory.recentLearnings) sections.push(`- ${l}`);
    sections.push("");
  }

  return sections.join("\n").trim() + "\n";
}

export function getRepoMemory(repoPath = process.cwd(), env = process.env) {
  const slug = getRepoSlug(repoPath);
  const db = getDb(env);

  let jsonMem = {
    slug,
    path: path.resolve(repoPath),
    lastUpdated: new Date().toISOString(),
    techStack: [],
    conventions: [],
    testCommands: [],
    buildCommands: [],
    architecturalNotes: [],
    recentLearnings: [],
  };

  if (db) {
    const row = db.prepare("SELECT * FROM repo_memory WHERE slug = ?").get(slug);
    if (row) {
      jsonMem = {
        slug: row.slug,
        path: row.path,
        lastUpdated: row.last_updated,
        techStack: JSON.parse(row.tech_stack || "[]"),
        conventions: JSON.parse(row.conventions || "[]"),
        testCommands: JSON.parse(row.test_commands || "[]"),
        buildCommands: JSON.parse(row.build_commands || "[]"),
        architecturalNotes: JSON.parse(row.architectural_notes || "[]"),
        recentLearnings: JSON.parse(row.recent_learnings || "[]"),
      };
    }
  }

  const memoryMdPath = path.join(path.resolve(repoPath), "MEMORY.md");
  if (fs.existsSync(memoryMdPath)) {
    try {
      const content = fs.readFileSync(memoryMdPath, "utf8");
      const parsed = parseMemoryMarkdown(content);
      for (const key of ["techStack", "conventions", "testCommands", "buildCommands", "architecturalNotes", "recentLearnings"]) {
        const mergedSet = new Set([...(jsonMem[key] || []), ...(parsed[key] || [])]);
        jsonMem[key] = Array.from(mergedSet);
      }
    } catch {}
  }

  return jsonMem;
}

export function storeRepoMemory(repoPath = process.cwd(), updates = {}, options = {}, env = process.env) {
  const slug = getRepoSlug(repoPath);
  const current = getRepoMemory(repoPath, env);
  const db = getDb(env);
  const now = new Date().toISOString();

  const merged = {
    ...current,
    ...updates,
    slug,
    path: path.resolve(repoPath),
    lastUpdated: now,
  };

  for (const key of ["techStack", "conventions", "testCommands", "buildCommands", "architecturalNotes", "recentLearnings"]) {
    if (Array.isArray(updates[key])) {
      merged[key] = Array.from(new Set([...(current[key] || []), ...updates[key]]));
    }
  }

  if (db) {
    const stmt = db.prepare(`
      INSERT INTO repo_memory (slug, path, last_updated, tech_stack, conventions, test_commands, build_commands, architectural_notes, recent_learnings)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(slug) DO UPDATE SET
        path = excluded.path,
        last_updated = excluded.last_updated,
        tech_stack = excluded.tech_stack,
        conventions = excluded.conventions,
        test_commands = excluded.test_commands,
        build_commands = excluded.build_commands,
        architectural_notes = excluded.architectural_notes,
        recent_learnings = excluded.recent_learnings
    `);
    stmt.run(
      slug,
      merged.path,
      now,
      JSON.stringify(merged.techStack),
      JSON.stringify(merged.conventions),
      JSON.stringify(merged.testCommands),
      JSON.stringify(merged.buildCommands),
      JSON.stringify(merged.architecturalNotes),
      JSON.stringify(merged.recentLearnings)
    );
  }

  const memoryMdPath = path.join(path.resolve(repoPath), "MEMORY.md");
  if (fs.existsSync(memoryMdPath) || options.syncFile === true) {
    try {
      const mdContent = formatMemoryMarkdown(merged, slug);
      const tempPath = `${memoryMdPath}.${Date.now()}.tmp`;
      fs.writeFileSync(tempPath, mdContent, "utf8");
      fs.renameSync(tempPath, memoryMdPath);
    } catch {}
  }

  return true;
}

export function syncRepoMemoryFile(repoPath = process.cwd(), env = process.env) {
  const current = getRepoMemory(repoPath, env);
  return storeRepoMemory(repoPath, current, { syncFile: true }, env);
}

// ----------------------------------------------------------------------------
// Unified Recall & System Prompt Generation
// ----------------------------------------------------------------------------

export function recallMemory({ query = "", repoPath = process.cwd(), limit = 10 } = {}, env = process.env) {
  const slug = getRepoSlug(repoPath);
  const repoMem = getRepoMemory(repoPath, env);
  const fleetMem = getFleetMemory(env);
  const relevantMistakes = listMistakes({ repo: slug, query, limit: 8 }, env);

  return {
    repoSlug: slug,
    repoMemory: repoMem,
    fleetMemory: fleetMem.crossRepoKnowledge || {},
    relevantMistakes,
  };
}

export function getSystemPromptMemoryBlock(repoPath = process.cwd(), env = process.env) {
  const slug = getRepoSlug(repoPath);
  const repoMem = getRepoMemory(repoPath, env);
  const mistakes = listMistakes({ repo: slug, limit: 6 }, env);
  const fleetMem = getFleetMemory(env);

  const sections = [];

  // 1. Repo Context & Conventions
  if (repoMem.testCommands?.length > 0 || repoMem.conventions?.length > 0 || repoMem.recentLearnings?.length > 0) {
    let repoSection = `### Repository Memory (${slug})\n`;
    if (repoMem.testCommands?.length > 0) {
      repoSection += `- **Verified Test Command(s)**: ${repoMem.testCommands.join("; ")}\n`;
    }
    if (repoMem.conventions?.length > 0) {
      repoSection += `- **Key Conventions**: ${repoMem.conventions.join("; ")}\n`;
    }
    if (repoMem.recentLearnings?.length > 0) {
      repoSection += `- **Recent Learnings**:\n${repoMem.recentLearnings.slice(-4).map((l) => `  * ${l}`).join("\n")}\n`;
    }
    sections.push(repoSection);
  }

  // 2. High-Priority Past Mistakes to Avoid
  if (mistakes.length > 0) {
    let mistakesSection = `### Past Mistakes & Critical Pitfalls to Avoid (DO NOT REPEAT):\n`;
    for (const m of mistakes) {
      mistakesSection += `- ⚠️ **${m.errorSignature}**\n  * Mistake: ${m.mistakeDescription}\n  * Proven Resolution: ${m.correctFix}\n`;
    }
    sections.push(mistakesSection);
  }

  // 3. Fleet Invariants
  if (fleetMem.invariants?.length > 0) {
    let invSection = `### Fleet-Wide Operational Invariants:\n`;
    for (const inv of fleetMem.invariants) {
      invSection += `- ${inv}\n`;
    }
    sections.push(invSection);
  }

  if (sections.length === 0) return "";

  return [
    "<persistent_cross_session_memory>",
    "The following knowledge is preserved across past runs, subagents, and fleet executions:",
    ...sections,
    "</persistent_cross_session_memory>",
  ].join("\n");
}
