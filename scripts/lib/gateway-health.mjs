import { existsSync, readFileSync, writeFileSync, utimesSync, mkdirSync } from "node:fs";
import * as fs from "node:fs";
import path from "node:path";

const OPEN_MS = 30 * 60 * 1000;

function filePath(root) {
  return path.join(root || process.cwd(), "state", "gateway-health.json");
}

export function markGatewayDown(root = process.cwd(), reason = "model unavailable") {
  try {
    const p = filePath(root);
    mkdirSyncSafe(p);
    writeFileSync(p, JSON.stringify({ downSince: new Date().toISOString(), reason: String(reason).slice(0, 200) }));
  } catch {}
}

export function markGatewayUp(root = process.cwd()) {
  try {
    const p = filePath(root);
    if (existsSync(p)) {
      const t = new Date().toISOString();
      utimesSync(p, new Date(t), new Date(t));
      writeFileSync(p, JSON.stringify({ recoveredAt: t }));
    }
  } catch {}
}

export function gatewayCircuitOpen(root = process.cwd()) {
  try {
    const p = filePath(root);
    if (!existsSync(p)) return false;
    const data = JSON.parse(readFileSync(p, "utf8"));
    const stamp = data.downSince || data.recoveredAt;
    if (!stamp) return false;
    const age = Date.now() - Date.parse(stamp);
    if (data.downSince && age < OPEN_MS) return true;
    return false;
  } catch {
    return false;
  }
}

function mkdirSyncSafe(p) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
}
