#!/usr/bin/env node
/**
 * ============================================================================
 * FLEET PERSISTENT MEMORY MCP SERVER (stdio)
 * ============================================================================
 * Exposes persistent memory tools to OpenCode agents and subagents:
 * - memory_recall: retrieve repo architecture, conventions, and past learnings
 * - memory_store: save critical discoveries, architectural decisions, and conventions
 * - memory_record_mistake: store error signatures, anti-patterns, and proven fixes
 * - memory_list_mistakes: browse known pitfalls to avoid repeating them
 * ============================================================================
 */

import readline from "node:readline";
import {
  recallMemory,
  storeRepoMemory,
  storeFleetKnowledge,
  recordMistake,
  listMistakes,
  getRepoMemory,
  getRepoSlug,
} from "./persistent-memory.mjs";

const TOOLS = [
  {
    name: "memory_recall",
    description: "Recall persistent memory, architecture notes, conventions, and relevant past mistakes across runs for the current repository or fleet.",
    inputSchema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "Search query or topic to look up (e.g. 'test commands', 'auth error', 'build')",
        },
        repoPath: {
          type: "string",
          description: "Optional repository path (defaults to current working directory)",
        },
      },
    },
  },
  {
    name: "memory_store",
    description: "Store a durable finding, convention, test command, or architectural decision into persistent memory so future agents and runs retain it.",
    inputSchema: {
      type: "object",
      properties: {
        category: {
          type: "string",
          enum: ["convention", "test_command", "build_command", "architecture", "learning", "fleet"],
          description: "Category of memory to store",
        },
        key: {
          type: "string",
          description: "Short descriptive key or title",
        },
        value: {
          type: "string",
          description: "Detailed description, instruction, or command",
        },
        repoPath: {
          type: "string",
          description: "Optional repository path (defaults to current working directory)",
        },
      },
      required: ["category", "value"],
    },
  },
  {
    name: "memory_record_mistake",
    description: "Record a critical failure, bug, or anti-pattern along with its exact proven fix so no agent or fleet run repeats this mistake.",
    inputSchema: {
      type: "object",
      properties: {
        errorSignature: {
          type: "string",
          description: "The exact error string, exit code, or failure pattern",
        },
        mistakeDescription: {
          type: "string",
          description: "What was done wrong, why it failed, or the false assumption",
        },
        correctFix: {
          type: "string",
          description: "The concrete, verified fix or invariant to follow instead",
        },
        repo: {
          type: "string",
          description: "Repository slug (e.g. 'fleet-control', 'fleet-runtime', or 'global')",
        },
        tags: {
          type: "array",
          items: { type: "string" },
          description: "Keywords for quick indexing (e.g. ['github-api', 'auth', 'test'])",
        },
      },
      required: ["errorSignature", "mistakeDescription", "correctFix"],
    },
  },
  {
    name: "memory_list_mistakes",
    description: "List all documented pitfalls and mistakes to avoid for this repository or globally.",
    inputSchema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "Optional search filter",
        },
        repo: {
          type: "string",
          description: "Optional repository slug filter (defaults to current repo)",
        },
        limit: {
          type: "number",
          description: "Maximum number of mistakes to return (default: 20)",
        },
      },
    },
  },
];

export function handleToolCall(name, args = {}, env = process.env) {
  switch (name) {
    case "memory_recall": {
      const result = recallMemory({
        query: args.query || "",
        repoPath: args.repoPath || process.cwd(),
      }, env);
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
      };
    }
    case "memory_store": {
      const { category, key, value, repoPath } = args;
      const cwd = repoPath || process.cwd();
      const current = getRepoMemory(cwd, env);

      if (category === "fleet") {
        storeFleetKnowledge(key || "general", value, "general", env);
      } else if (category === "test_command") {
        const tests = Array.from(new Set([...(current.testCommands || []), value]));
        storeRepoMemory(cwd, { testCommands: tests }, {}, env);
      } else if (category === "build_command") {
        const builds = Array.from(new Set([...(current.buildCommands || []), value]));
        storeRepoMemory(cwd, { buildCommands: builds }, {}, env);
      } else if (category === "convention") {
        const convs = Array.from(new Set([...(current.conventions || []), value]));
        storeRepoMemory(cwd, { conventions: convs }, {}, env);
      } else if (category === "architecture") {
        const arch = Array.from(new Set([...(current.architecturalNotes || []), value]));
        storeRepoMemory(cwd, { architecturalNotes: arch }, {}, env);
      } else {
        const learnings = Array.from(new Set([...(current.recentLearnings || []), value]));
        storeRepoMemory(cwd, { recentLearnings: learnings }, {}, env);
      }

      return {
        content: [{ type: "text", text: `Memory stored successfully under '${category}': ${value}` }],
      };
    }
    case "memory_record_mistake": {
      const slug = args.repo || getRepoSlug(process.cwd());
      recordMistake({
        errorSignature: args.errorSignature,
        mistakeDescription: args.mistakeDescription,
        correctFix: args.correctFix,
        repo: slug,
        tags: args.tags || [],
      }, env);
      return {
        content: [{ type: "text", text: `Mistake recorded successfully in ledger for '${slug}'. Future runs will guard against: ${args.errorSignature}` }],
      };
    }
    case "memory_list_mistakes": {
      const slug = args.repo || getRepoSlug(process.cwd());
      const mistakes = listMistakes({
        repo: slug,
        query: args.query || null,
        limit: args.limit || 20,
      }, env);
      return {
        content: [{ type: "text", text: JSON.stringify(mistakes, null, 2) }],
      };
    }
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

// Stdio JSON-RPC interface for standalone invocation
if (process.argv[1] && process.argv[1].endsWith("memory-mcp-server.mjs")) {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: false,
  });

  rl.on("line", (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;

    try {
      const msg = JSON.parse(trimmed);
      if (!msg.id && msg.method) return;

      if (msg.method === "initialize") {
        const response = {
          jsonrpc: "2.0",
          id: msg.id,
          result: {
            protocolVersion: "2024-11-05",
            capabilities: { tools: {} },
            serverInfo: { name: "fleet-persistent-memory", version: "1.0.0" },
          },
        };
        process.stdout.write(JSON.stringify(response) + "\n");
        return;
      }

      if (msg.method === "tools/list") {
        const response = {
          jsonrpc: "2.0",
          id: msg.id,
          result: { tools: TOOLS },
        };
        process.stdout.write(JSON.stringify(response) + "\n");
        return;
      }

      if (msg.method === "tools/call") {
        const { name, arguments: toolArgs } = msg.params || {};
        try {
          const result = handleToolCall(name, toolArgs);
          const response = { jsonrpc: "2.0", id: msg.id, result };
          process.stdout.write(JSON.stringify(response) + "\n");
        } catch (err) {
          const response = {
            jsonrpc: "2.0",
            id: msg.id,
            result: {
              content: [{ type: "text", text: `Error: ${err.message}` }],
              isError: true,
            },
          };
          process.stdout.write(JSON.stringify(response) + "\n");
        }
        return;
      }

      const response = {
        jsonrpc: "2.0",
        id: msg.id,
        error: { code: -32601, message: `Method not found: ${msg.method}` },
      };
      process.stdout.write(JSON.stringify(response) + "\n");
    } catch {}
  });
}
