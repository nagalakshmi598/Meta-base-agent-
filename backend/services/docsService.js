// ── DOCUMENTATION RETRIEVAL (RAG) ──────────────────────────────────────────
// Loads product docs from backend/docs/*.{md,txt}, splits them into chunks, and
// does lightweight keyword retrieval (no vector DB / no external calls). The AI
// service then answers strictly from the retrieved chunks (with citations).
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DOCS_DIR = path.join(__dirname, '..', 'docs');

const STOPWORDS = new Set('the a an of to in is are for and or how does do what which with on at by from as be this that it its our we you your can will has have was were about into'.split(' '));

function tokenize(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/)
    .filter(w => w.length > 2 && !STOPWORDS.has(w));
}

// Split a doc into ~900-char chunks, preferring markdown heading boundaries.
function chunkText(text, maxLen = 900) {
  const sections = text.split(/\n(?=#{1,6}\s)/); // split before markdown headings
  const chunks = [];
  for (const sec of sections) {
    const trimmed = sec.trim();
    if (!trimmed) continue;
    if (trimmed.length <= maxLen) { chunks.push(trimmed); continue; }
    // long section → split by paragraphs, packing up to maxLen
    let buf = '';
    for (const para of trimmed.split(/\n\s*\n/)) {
      if ((buf + '\n\n' + para).length > maxLen && buf) { chunks.push(buf.trim()); buf = para; }
      else { buf = buf ? buf + '\n\n' + para : para; }
    }
    if (buf.trim()) chunks.push(buf.trim());
  }
  return chunks;
}

let _chunks = null;

function loadDocs() {
  const chunks = [];
  try {
    const files = fs.readdirSync(DOCS_DIR).filter(f => /\.(md|markdown|txt)$/i.test(f) && f.toLowerCase() !== 'readme.md');
    for (const file of files) {
      const text = fs.readFileSync(path.join(DOCS_DIR, file), 'utf8');
      chunkText(text).forEach((c, i) => chunks.push({ source: file, idx: i, text: c, tokens: tokenize(c) }));
    }
  } catch { /* no docs dir → empty */ }
  return chunks;
}

function chunks() { if (!_chunks) _chunks = loadDocs(); return _chunks; }

export function reloadDocs() { _chunks = loadDocs(); return _chunks.length; }
export function getDocsCount() { return chunks().length; }

// Return the top-k most relevant chunks for a query (keyword overlap scoring).
export function searchDocs(query, k = 4) {
  const qWords = tokenize(query);
  if (!qWords.length) return [];
  const scored = chunks().map(c => {
    let score = 0;
    for (const qw of qWords) {
      for (const tw of c.tokens) {
        if (tw === qw) score += 3;
        else if (tw.length > 3 && (tw.startsWith(qw) || qw.startsWith(tw))) score += 1;
      }
    }
    return { c, score };
  }).filter(x => x.score > 0).sort((a, b) => b.score - a.score).slice(0, k);
  return scored.map(x => ({ source: x.c.source, text: x.c.text }));
}
