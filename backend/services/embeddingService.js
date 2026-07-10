// ── EMBEDDINGS (for semantic doc RAG) ──────────────────────────────────────
// Turns text into vectors using the SAME provider keys as the chat LLM
//   • Gemini  → text-embedding-004  (batchEmbedContents REST)
//   • OpenAI  → text-embedding-3-small
// Anthropic has no embeddings API, so it's skipped. Every function degrades
// gracefully: if no embedding provider is available or a call fails, embed()
// returns null and the caller falls back to keyword search. Live-data querying
// does NOT use this — it's purely for documentation retrieval.
import axios from 'axios';

const GEMINI_EMBED_MODEL = (process.env.GEMINI_EMBED_MODEL || 'gemini-embedding-001').trim();
const OPENAI_EMBED_MODEL = (process.env.OPENAI_EMBED_MODEL || 'text-embedding-3-small').trim();

// Resolve provider keys the same way aiService does (prefix-classified so a key
// pasted into the wrong env field still works). Priority: Gemini → OpenAI.
function resolveEmbedProvider() {
  const val = v => { v = (v || '').trim(); return (v && !v.startsWith('your_')) ? v : null; };
  const fields = [process.env.GEMINI_API_KEY, process.env.OPENAI_API_KEY, process.env.ANTHROPIC_API_KEY].map(val).filter(Boolean);
  let geminiKey = null, openaiKey = null;
  for (const k of fields) {
    if (k.startsWith('AIza')) geminiKey = geminiKey || k;
    else if (k.startsWith('sk-ant')) { /* anthropic: no embeddings */ }
    else if (k.startsWith('sk-')) openaiKey = openaiKey || k;
  }
  const gk = val(process.env.GEMINI_API_KEY);
  if (!geminiKey && gk && !gk.startsWith('sk-')) geminiKey = gk;
  if (geminiKey) return { provider: 'gemini', key: geminiKey };
  if (openaiKey) return { provider: 'openai', key: openaiKey };
  return { provider: null, key: null };
}

export function hasEmbeddingProvider() {
  return !!resolveEmbedProvider().provider;
}

let _openai = null;
async function openaiClient(key) {
  if (_openai) return _openai;
  const { default: OpenAI } = await import('openai');
  _openai = new OpenAI({ apiKey: key });
  return _openai;
}

// Embed an array of strings → array of number[] vectors (same order), or null on
// failure / no provider. Batches to keep request sizes sane.
export async function embed(texts) {
  const list = (texts || []).map(t => String(t ?? '')).filter(t => t.length);
  if (!list.length) return [];
  const { provider, key } = resolveEmbedProvider();
  if (!provider) return null;

  try {
    const out = [];
    if (provider === 'gemini') {
      // The gemini-embedding-* models expose single-item :embedContent (not the
      // sync batch endpoint), so embed per text with limited concurrency. The doc
      // corpus is small, so this is a handful of quick calls.
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_EMBED_MODEL}:embedContent?key=${key}`;
      const CONC = 8;
      for (let i = 0; i < list.length; i += CONC) {
        const slice = list.slice(i, i + CONC);
        const vecs = await Promise.all(slice.map(async text => {
          const body = { model: `models/${GEMINI_EMBED_MODEL}`, content: { parts: [{ text }] } };
          const resp = await axios.post(url, body, { timeout: 30000, headers: { 'Content-Type': 'application/json' } });
          return resp.data?.embedding?.values || resp.data?.embedding || null;
        }));
        out.push(...vecs);
      }
    } else { // openai — native batch input
      const client = await openaiClient(key);
      const BATCH = 96;
      for (let i = 0; i < list.length; i += BATCH) {
        const resp = await client.embeddings.create({ model: OPENAI_EMBED_MODEL, input: list.slice(i, i + BATCH) });
        for (const d of (resp.data || [])) out.push(d.embedding || null);
      }
    }
    // A partial/failed batch (null vectors) makes cosine unreliable → bail to keyword.
    if (out.length !== list.length || out.some(v => !Array.isArray(v) || !v.length)) return null;
    return out;
  } catch (e) {
    console.warn('[Embeddings] failed, will fall back to keyword search:', e.response?.status || e.message);
    return null;
  }
}

// Embed a single query string → one vector (or null).
export async function embedOne(text) {
  const r = await embed([text]);
  return r && r.length ? r[0] : null;
}

// Cosine similarity between two equal-length vectors.
export function cosine(a, b) {
  if (!a || !b || a.length !== b.length) return 0;
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  if (!na || !nb) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}
