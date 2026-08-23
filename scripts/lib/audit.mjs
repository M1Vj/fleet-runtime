import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

export class AuditBuffer {
  constructor(redactFn) {
    this.entries = [];
    this.redact = redactFn || ((s) => String(s));
    this.startedAt = new Date().toISOString();
    this.incidents = [];
  }

  note(step, msg, obj) {
    this.entries.push({ t: new Date().toISOString(), step, msg: this.redact(msg), data: obj ? JSON.parse(this.redact(JSON.stringify(obj))) : undefined });
  }

  incident(step, msg, obj) {
    const entry = { t: new Date().toISOString(), step, msg: this.redact(msg), data: obj ? JSON.parse(this.redact(JSON.stringify(obj))) : undefined };
    this.incidents.push(entry);
    this.entries.push(entry);
  }

  writeMarkdown(auditDir, runId, title, status, meta = {}) {
    const finishedAt = new Date().toISOString();
    const wallMs = Math.round((Date.parse(finishedAt) - Date.parse(this.startedAt)) || 0);
    const day = this.startedAt.slice(0, 10);
    const dir = path.join(auditDir, day);
    mkdirSync(dir, { recursive: true });
    const lines = [];
    lines.push("---");
    lines.push(`lane: ${meta.lane || title.toLowerCase().replace(/[^a-z]+/g, "-").replace(/^-|-$/g, "")}`);
    lines.push(`outcome: ${String(status).toLowerCase().startsWith("ok") || status === "PASSED" ? "success" : String(status).toLowerCase().includes("block") ? "blocked" : "failure"}`);
    lines.push(`retries: ${meta.retries ?? 0}`);
    lines.push(`wall_ms: ${wallMs}`);
    lines.push("---");
    lines.push(`# ${title}`);
    lines.push("");
    lines.push(`- runId: ${runId}`);
    lines.push(`- startedAt: ${this.startedAt}`);
    lines.push(`- finishedAt: ${finishedAt}`);
    lines.push(`- status: ${status}`);
    if (this.incidents.length > 0) {
      lines.push(`- incidents: ${this.incidents.length}`);
    }
    lines.push("");
    lines.push("## Steps");
    for (const e of this.entries) {
      lines.push(`- \`${e.t}\` **${e.step}** ${e.msg}${e.data !== undefined ? ` — \`${JSON.stringify(e.data)}\`` : ""}`);
    }
    if (this.incidents.length > 0) {
      lines.push("");
      lines.push("## Incidents");
      for (const e of this.incidents) {
        lines.push(`- \`${e.t}\` **${e.step}** ${e.msg}${e.data !== undefined ? ` — \`${JSON.stringify(e.data)}\`` : ""}`);
      }
    }
    lines.push("");
    const file = path.join(dir, `${runId}.md`);
    writeFileSync(file, lines.join("\n"), "utf8");
    return file;
  }
}
