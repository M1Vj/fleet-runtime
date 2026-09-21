import {
  CORE_INTEGRITY_OK,
  CORE_LOCK_DIGEST,
  applyRequestCapabilities,
} from "../../packages/indefinite-core/index.mjs";

export const CORE_SANITIZER_DIGEST = CORE_LOCK_DIGEST;

// ============================================================================
// OPENCODE INDEFINITE REQUEST SANITIZER & SCHEMA REPAIR
// ============================================================================
// Core responsibilities:
// 1. Permanently eliminate `[invalid_request_error] reasoning encrypted_content was not issued to this caller`:
//    - Omit past `type: "reasoning"` items from OpenAI Responses API wire format (parsed.input).
//    - Recursively strip all `encrypted_content` and `reasoningEncryptedContent` tokens.
// 2. Schema Repair: Ensure all function/tool call `arguments` are strictly valid JSON strings to prevent
//    Cloudflare 400 Bad Request (`[invalid_request_error] arguments must be valid JSON`).
// 3. Selective payload auto-pruning: Only when payload exceeds 64KB (65536 bytes), prune historical data URIs
//    and bound historical tool outputs to keep request payloads under ~50KB to prevent proxy drops.
// ============================================================================

export function ensureValidJsonString(raw) {
  if (typeof raw !== "string") {
    return { valid: false, value: JSON.stringify(raw ?? {}) };
  }
  try {
    JSON.parse(raw);
    return { valid: true, value: raw };
  } catch {
    return { valid: false, value: JSON.stringify({ raw_unparsed: raw }) };
  }
}

function callIdFor(item) {
  if (!item || typeof item !== "object") return "";
  return String(item.call_id || item.callId || item.callID || item.tool_call_id || "");
}

function normalizeToolOutput(output) {
  if (typeof output === "string") return output;
  const serialized = JSON.stringify(output);
  return serialized === undefined ? String(output ?? "") : serialized;
}

const STRICT_TOOL_OUTPUT_MAX_BYTES = 1024 * 1024;
const STRICT_RECENT_TOOL_PAIRS_TO_PRESERVE = 4;

function boundHistoricalToolOutput(output, maxBytes = STRICT_TOOL_OUTPUT_MAX_BYTES) {
  const normalized = normalizeToolOutput(output);
  const originalBytes = Buffer.byteLength(normalized, "utf8");
  if (originalBytes <= maxBytes) {
    return { value: normalized, truncated: false, originalBytes };
  }
  const marker = `\n...[historical tool output truncated during request repair; original ${originalBytes} bytes]`;
  const markerBytes = Buffer.byteLength(marker, "utf8");
  const prefixBudget = Math.max(0, maxBytes - markerBytes);
  let prefix = Buffer.from(normalized, "utf8").subarray(0, prefixBudget).toString("utf8");
  while (Buffer.byteLength(prefix + marker, "utf8") > maxBytes) {
    prefix = prefix.slice(0, -1);
  }
  return { value: prefix + marker, truncated: true, originalBytes };
}

function removeItemReferencesDeep(value) {
  let removed = 0;
  const visit = (node) => {
    if (Array.isArray(node)) {
      for (let index = node.length - 1; index >= 0; index--) {
        const item = node[index];
        if (item && typeof item === "object" && item.type === "item_reference") {
          node.splice(index, 1);
          removed++;
        } else {
          visit(item);
        }
      }
      return;
    }
    if (!node || typeof node !== "object") return;
    for (const [key, child] of Object.entries(node)) {
      if ((node.type === "function_call_output" || node.type === "tool_result") && key === "output") continue;
      visit(child);
    }
  };
  visit(value);
  return removed;
}

const STRICT_CHAT_MESSAGE_KEYS = new Set([
  "role", "content", "name", "tool_calls", "tool_call_id", "function", "refusal", "audio",
]);

function stripNonStandardChatMessageFields(messages) {
  let removed = 0;
  for (const message of messages) {
    if (!message || typeof message !== "object" || Array.isArray(message)) continue;
    for (const key of Object.keys(message)) {
      if (!STRICT_CHAT_MESSAGE_KEYS.has(key)) {
        delete message[key];
        removed++;
      }
    }
  }
  return removed;
}

export function sanitizeRequestBody(bodyBuffer, requestId = "", options = {}) {
  if (!bodyBuffer || bodyBuffer.length === 0) return bodyBuffer;
  const logger = typeof options.logger === "function" ? options.logger : () => {};

  try {
    const rawStr = Buffer.isBuffer(bodyBuffer) ? bodyBuffer.toString("utf8") : String(bodyBuffer);
    const parsed = JSON.parse(rawStr);
    let bodyModified = false;

    if (typeof parsed.model === "string") {
      const cleanModel = parsed.model.replace(/^opencode\//, "").trim();
      if (cleanModel === "union-alpha" || cleanModel === "union" || cleanModel === "alpha") {
        parsed.model = "muse-spark-1.3-contributor-free";
        bodyModified = true;
      }
    }

    if (options.forceFullStrip && Array.isArray(parsed.input)) {
      const origInputLen = parsed.input.length;
      parsed.input = parsed.input.filter((item) => {
        if (!item || typeof item !== "object") return true;
        if (item.type === "reasoning") {
          bodyModified = true;
          return false;
        }
        return true;
      });
      if (parsed.input.length !== origInputLen) {
        logger("INFO", `[REASONING_PRUNED] Omitted ${origInputLen - parsed.input.length} historical reasoning items from input`, { requestId });
      }

      for (const item of parsed.input) {
        if (!item || typeof item !== "object") continue;
        if (item.encrypted_content !== undefined) {
          delete item.encrypted_content;
          bodyModified = true;
        }
        if (item.reasoningEncryptedContent !== undefined) {
          delete item.reasoningEncryptedContent;
          bodyModified = true;
        }
        if (item.metadata?.openai?.reasoningEncryptedContent !== undefined) {
          delete item.metadata.openai.reasoningEncryptedContent;
          bodyModified = true;
        }
        if (item.metadata?.openai?.encrypted_content !== undefined) {
          delete item.metadata.openai.encrypted_content;
          bodyModified = true;
        }
      }
    }

    if (options.forceFullStrip) {
      const removedReferences = removeItemReferencesDeep(parsed);
      if (removedReferences > 0) {
        bodyModified = true;
        logger("INFO", `[ITEM_REFERENCES_REPAIRED] Omitted ${removedReferences} caller-bound item references`, { requestId });
      }
    }

    if (options.forceFullStrip && Array.isArray(parsed.input)) {
      const originalLength = parsed.input.length;
      const calls = new Set();
      const outputs = new Set();
      for (const item of parsed.input) {
        if (!item || typeof item !== "object") continue;
        const callId = callIdFor(item);
        if (!callId) continue;
        if (item.type === "function_call" || item.type === "tool_call") calls.add(callId);
        if (item.type === "function_call_output" || item.type === "tool_result") outputs.add(callId);
      }
      const paired = new Set([...calls].filter((callId) => outputs.has(callId)));
      parsed.input = parsed.input.filter((item) => {
        if (!item || typeof item !== "object") return true;
        const isCall = item.type === "function_call" || item.type === "tool_call";
        const isOutput = item.type === "function_call_output" || item.type === "tool_result";
        if (!isCall && !isOutput) return true;
        return paired.has(callIdFor(item));
      });
      const pairedOutputIds = parsed.input
        .filter((item) => item?.type === "function_call_output" || item?.type === "tool_result")
        .map(callIdFor)
        .filter(Boolean);
      const recentOutputIds = new Set(pairedOutputIds.slice(-STRICT_RECENT_TOOL_PAIRS_TO_PRESERVE));
      for (const item of parsed.input) {
        if (!item || typeof item !== "object") continue;
        if (item.type === "message" || item.type === "function_call" || item.type === "tool_call" || item.type === "function_call_output" || item.type === "tool_result") {
          if (item.id !== undefined) {
            delete item.id;
            bodyModified = true;
          }
        }
        if (item.type === "function_call_output" || item.type === "tool_result") {
          const bounded = recentOutputIds.has(callIdFor(item))
            ? { value: normalizeToolOutput(item.output), truncated: false, originalBytes: Buffer.byteLength(normalizeToolOutput(item.output), "utf8") }
            : boundHistoricalToolOutput(item.output);
          if (item.output !== bounded.value) {
            item.output = bounded.value;
            bodyModified = true;
          }
          if (bounded.truncated) {
            logger("WARN", `[TOOL_OUTPUT_BOUNDED] Bounded an oversized historical tool output (${bounded.originalBytes} bytes) during strict repair`, { requestId });
          }
        }
      }
      if (parsed.input.length !== originalLength) {
        bodyModified = true;
        logger("INFO", `[TOOL_HISTORY_REPAIRED] Omitted ${originalLength - parsed.input.length} incomplete tool-history items`, { requestId });
      }
    }

    if (options.forceFullStrip && Array.isArray(parsed.messages)) {
      const removedMessageFields = stripNonStandardChatMessageFields(parsed.messages);
      if (removedMessageFields > 0) {
        bodyModified = true;
        logger("INFO", `[CHAT_MESSAGE_FIELDS_REPAIRED] Omitted ${removedMessageFields} non-standard strict-schema fields`, { requestId });
      }
    }

    if (options.forceFullStrip && Array.isArray(parsed.messages)) {
      for (const msg of parsed.messages) {
        if (!msg || typeof msg !== "object") continue;
        if (msg.encrypted_content !== undefined) {
          delete msg.encrypted_content;
          bodyModified = true;
        }
        if (msg.reasoningEncryptedContent !== undefined) {
          delete msg.reasoningEncryptedContent;
          bodyModified = true;
        }
        if (msg.metadata?.openai?.reasoningEncryptedContent !== undefined) {
          delete msg.metadata.openai.reasoningEncryptedContent;
          bodyModified = true;
        }
        if (msg.metadata?.openai?.encrypted_content !== undefined) {
          delete msg.metadata.openai.encrypted_content;
          bodyModified = true;
        }
        if (Array.isArray(msg.content)) {
          const origContentLen = msg.content.length;
          msg.content = msg.content.filter((part) => {
            if (!part || typeof part !== "object") return true;
            if (part.type === "reasoning") {
              bodyModified = true;
              return false;
            }
            return true;
          });
          for (const part of msg.content) {
            if (!part || typeof part !== "object") continue;
            if (part.encrypted_content !== undefined) {
              delete part.encrypted_content;
              bodyModified = true;
            }
            if (part.reasoningEncryptedContent !== undefined) {
              delete part.reasoningEncryptedContent;
              bodyModified = true;
            }
          }
        }
      }
    }

    if (options.forceFullStrip && Array.isArray(parsed.parts)) {
      parsed.parts = parsed.parts.filter((p) => {
        if (!p || typeof p !== "object") return true;
        if (p.type === "reasoning") {
          bodyModified = true;
          return false;
        }
        return true;
      });
      for (const p of parsed.parts) {
        if (!p || typeof p !== "object") continue;
        if (p.metadata?.openai?.reasoningEncryptedContent !== undefined) {
          delete p.metadata.openai.reasoningEncryptedContent;
          bodyModified = true;
        }
        if (p.metadata?.openai?.encrypted_content !== undefined) {
          delete p.metadata.openai.encrypted_content;
          bodyModified = true;
        }
        if (p.reasoningEncryptedContent !== undefined) {
          delete p.reasoningEncryptedContent;
          bodyModified = true;
        }
        if (p.encrypted_content !== undefined) {
          delete p.encrypted_content;
          bodyModified = true;
        }
      }
    }

    if (options.forceFullStrip && Array.isArray(parsed.input)) {
      for (const item of parsed.input) {
        if (!item || typeof item !== "object") continue;
        if (item.type === "function_call" || item.type === "tool_call") {
          if (item.arguments !== undefined) {
            const res = ensureValidJsonString(item.arguments);
            if (!res.valid) {
              item.arguments = res.value;
              bodyModified = true;
            }
          }
          if (item.function && item.function.arguments !== undefined) {
            const res = ensureValidJsonString(item.function.arguments);
            if (!res.valid) {
              item.function.arguments = res.value;
              bodyModified = true;
            }
          }
        }
      }
    }
    if (options.forceFullStrip && Array.isArray(parsed.messages)) {
      for (const msg of parsed.messages) {
        if (!msg || typeof msg !== "object") continue;
        if (Array.isArray(msg.tool_calls)) {
          for (const tc of msg.tool_calls) {
            if (tc && tc.function && tc.function.arguments !== undefined) {
              const res = ensureValidJsonString(tc.function.arguments);
              if (!res.valid) {
                tc.function.arguments = res.value;
                bodyModified = true;
              }
            }
          }
        }
      }
    }

    const inputByteLength = Buffer.isBuffer(bodyBuffer) ? bodyBuffer.length : Buffer.byteLength(rawStr);
    if (inputByteLength > 65536) {
      const TINY_PNG_DATA_URI = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";
      const pruneDataUrisDeep = (obj) => {
        if (!obj || typeof obj !== "object") return;
        for (const key of Object.keys(obj)) {
          const val = obj[key];
          if (typeof val === "string" && val.startsWith("data:image/") && val.length > 500) {
            obj[key] = TINY_PNG_DATA_URI;
            bodyModified = true;
          } else if (typeof val === "object") {
            pruneDataUrisDeep(val);
          }
        }
      };

      if (Array.isArray(parsed.input)) {
        const pairedOutputIds = parsed.input
          .filter((item) => item?.type === "function_call_output" || item?.type === "tool_result")
          .map(callIdFor)
          .filter(Boolean);
        const recentOutputIds = new Set(pairedOutputIds.slice(-STRICT_RECENT_TOOL_PAIRS_TO_PRESERVE));

        const historicalOutputs = parsed.input.filter((item) => {
          if (!item || typeof item !== "object") return false;
          if (item.type !== "function_call_output" && item.type !== "tool_result") return false;
          return !recentOutputIds.has(callIdFor(item));
        });
        const historicalBudget = Math.min(8192, Math.max(1024, Math.floor(32768 / Math.max(1, historicalOutputs.length))));

        const threshold = Math.max(0, parsed.input.length - 4);
        for (let i = 0; i < parsed.input.length; i++) {
          const isPastTurn = i < threshold;
          const item = parsed.input[i];
          if (!item || typeof item !== "object") continue;
          if (isPastTurn) {
            pruneDataUrisDeep(item);
            if (Array.isArray(item.attachments) && item.attachments.length > 0) {
              item.attachments = [];
              bodyModified = true;
            }
          }
          if (Array.isArray(item.content)) {
            for (const part of item.content) {
              if (!part || typeof part !== "object") continue;
              if (part.type === "image" || part.type === "image_url" || part.type === "input_image") {
                if (isPastTurn) {
                  part.image = "[pruned-historical-image]";
                  if (part.image_url) {
                    if (typeof part.image_url === "object" && part.image_url !== null) {
                      part.image_url.url = TINY_PNG_DATA_URI;
                    } else {
                      part.image_url = TINY_PNG_DATA_URI;
                    }
                  }
                  bodyModified = true;
                }
              }
            }
          }
          if ((item.type === "function_call_output" || item.type === "tool_result") && item.output !== undefined) {
            const callId = callIdFor(item);
            const isRecent = recentOutputIds.has(callId);
            if (!isRecent) {
              const bounded = boundHistoricalToolOutput(item.output, historicalBudget);
              if (bounded.truncated) {
                item.output = bounded.value;
                bodyModified = true;
                logger("WARN", `[TOOL_OUTPUT_BOUNDED] Bounded historical tool output (${bounded.originalBytes} -> ${Buffer.byteLength(bounded.value, "utf8")} bytes)`, { requestId, callId });
              }
            }
          }
        }
      }
      if (Array.isArray(parsed.messages)) {
        const threshold = Math.max(0, parsed.messages.length - 2);
        for (let i = 0; i < parsed.messages.length; i++) {
          const isPastTurn = i < threshold;
          const msg = parsed.messages[i];
          if (!msg || typeof msg !== "object") continue;
          if (isPastTurn) {
            pruneDataUrisDeep(msg);
            if (Array.isArray(msg.attachments) && msg.attachments.length > 0) {
              msg.attachments = [];
              bodyModified = true;
            }
          }
          if (msg.role === "tool" && msg.content !== undefined) {
            if (isPastTurn) {
              const bounded = boundHistoricalToolOutput(msg.content, 4096);
              if (bounded.truncated) {
                msg.content = bounded.value;
                bodyModified = true;
                logger("WARN", `[TOOL_OUTPUT_BOUNDED] Bounded historical message tool output (${bounded.originalBytes} bytes)`, { requestId });
              }
            }
          }
        }
      }
    }

    if (options.enforceCapabilities && applyRequestCapabilities(parsed)) bodyModified = true;

    if (bodyModified) {
      const sanitizedBuf = Buffer.from(JSON.stringify(parsed));
      logger("INFO", `[REQUEST_BODY_SANITIZED] Sanitized payload: ${inputByteLength} -> ${sanitizedBuf.length} bytes`, { requestId });
      return sanitizedBuf;
    }
  } catch (err) {
    logger("WARN", `[REQUEST_BODY_SANITIZE_ERROR] Could not parse/sanitize body: ${err.message}`, { requestId });
  }
  return bodyBuffer;
}
