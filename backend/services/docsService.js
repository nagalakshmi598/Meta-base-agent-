// ── DOCUMENTATION RETRIEVAL (RAG) ──────────────────────────────────────────
// Loads product docs from backend/docs/*.{md,txt}, splits them into chunks, and
// does lightweight keyword retrieval (no vector DB / no external calls). The AI
// service then answers strictly from the retrieved chunks (with citations).
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { embed, embedOne, cosine, hasEmbeddingProvider } from './embeddingService.js';

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

export function reloadDocs() { _chunks = loadDocs(); _embedded = false; _embedPromise = null; return _chunks.length; }
export function getDocsCount() { return chunks().length; }

// Keyword overlap score for one chunk against tokenized query words.
function keywordScore(chunk, qWords) {
  let score = 0;
  for (const qw of qWords) {
    for (const tw of chunk.tokens) {
      if (tw === qw) score += 3;
      else if (tw.length > 3 && (tw.startsWith(qw) || qw.startsWith(tw))) score += 1;
    }
  }
  return score;
}

// Return the top-k most relevant chunks for a query (keyword overlap scoring).
// Synchronous — used directly, and as the fallback when embeddings are off.
export function searchDocs(query, k = 4) {
  const qWords = tokenize(query);
  if (!qWords.length) return [];
  const scored = chunks().map(c => ({ c, score: keywordScore(c, qWords) }))
    .filter(x => x.score > 0).sort((a, b) => b.score - a.score).slice(0, k);
  return scored.map(x => ({ source: x.c.source, text: x.c.text }));
}

// ── SEMANTIC (VECTOR) RETRIEVAL ────────────────────────────────────────────
// Embeds every doc chunk once (in-memory), then ranks by cosine similarity to
// the query embedding — so paraphrases/synonyms match even without shared words
// ("who can I move data to?" → destination-platform docs). Blended with a small
// keyword bonus (hybrid) for robustness. Falls back to pure keyword search when
// no embedding provider is configured or an embedding call fails.
let _embedded = false;     // chunk vectors are ready
let _embedPromise = null;  // in-flight embedding build (dedupe concurrent calls)

async function ensureEmbeddings() {
  if (_embedded) return true;
  if (!hasEmbeddingProvider()) return false;
  if (!_embedPromise) {
    const cs = chunks();
    _embedPromise = (async () => {
      if (!cs.length) { _embedded = true; return true; }
      const vectors = await embed(cs.map(c => c.text));
      if (!vectors) return false;               // provider failed → keep keyword mode
      cs.forEach((c, i) => { c.vector = vectors[i]; });
      _embedded = true;
      console.log(`[Docs] Embedded ${cs.length} documentation chunks for semantic search`);
      return true;
    })().catch(err => { console.warn('[Docs] embedding build failed:', err.message); return false; });
  }
  return _embedPromise;
}

// Async semantic search. Returns [{source, text}] top-k, or null if semantic
// mode is unavailable (caller then uses keyword searchDocs).
export async function searchDocsSemantic(query, k = 4) {
  const ready = await ensureEmbeddings();
  if (!ready) return null;
  const qVec = await embedOne(query);
  if (!qVec) return null;

  const qWords = tokenize(query);
  const cs = chunks();
  const scored = cs.map(c => {
    const sim = c.vector ? cosine(qVec, c.vector) : 0;           // 0..1
    const kw = qWords.length ? keywordScore(c, qWords) : 0;      // small hybrid bonus
    return { c, score: sim + Math.min(kw, 6) * 0.03 };
  }).filter(x => x.score > 0.15).sort((a, b) => b.score - a.score).slice(0, k);

  return scored.map(x => ({ source: x.c.source, text: x.c.text }));
}
