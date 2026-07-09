// ── QUERY AUDIT LOG ────────────────────────────────────────────────────────
// Records every question the agent answered + the query it ran, for auditing.
// Persists to backend/logs/query-log.jsonl (one JSON record per line) and keeps
// a small in-memory buffer for fast retrieval.
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LOG_DIR  = path.join(__dirname, '..', 'logs');
const LOG_FILE = path.join(LOG_DIR, 'query-log.jsonl');

const MAX_RECENT = 500;
const recent = [];

function ensureDir() {
  try { if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true }); } catch {}
}

// Append one audit record. Never throws — logging must not break a request.
export function logQuery(entry) {
  const record = { time: new Date().toISOString(), ...entry };
  recent.push(record);
  if (recent.length > MAX_RECENT) recent.shift();
  try {
    ensureDir();
    // Synchronous append: low-frequency (one per question) and guarantees the
    // record is on disk immediately, so the audit endpoint always sees it.
    fs.appendFileSync(LOG_FILE, JSON.stringify(record) + '\n');
  } catch {}
  return record;
}

// Most-recent-first. Reads the file (source of truth, survives restarts);
// falls back to the in-memory buffer if the file can't be read.
export function getRecentLogs(limit = 100) {
  try {
    if (fs.existsSync(LOG_FILE)) {
      const lines = fs.readFileSync(LOG_FILE, 'utf8').trim().split('\n').filter(Boolean);
      return lines.slice(-limit)
        .map(l => { try { return JSON.parse(l); } catch { return null; } })
        .filter(Boolean)
        .reverse();
    }
  } catch {}
  return recent.slice(-limit).reverse();
}
