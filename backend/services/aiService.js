import dotenv from 'dotenv';
import axios from 'axios';
import {
  isMongoDB, getTopCollections, classifyDatabase,
  extractSpecificFilter, buildMongoQuery, buildKeywordSQL, isReasonQuestion
} from './queryService.js';
import { searchDocs, searchDocsSemantic } from './docsService.js';
dotenv.config();

let _client = null;
let _provider = null;          // 'gemini' | 'openai' | 'anthropic'
let _geminiKey = null;
let _clientChecked = false;
let _creditExhausted = false;

const ANTHROPIC_MODEL = 'claude-sonnet-4-6';
const OPENAI_MODEL = (process.env.OPENAI_MODEL || 'gpt-4o-mini').trim();
const GEMINI_MODEL = (process.env.GEMINI_MODEL || 'gemini-flash-lite-latest').trim();

// Resolve a usable key for each provider from its env field. Keys are also
// classified by prefix so a key pasted into the wrong field still works:
//   • AIza...     → Google Gemini
//   • sk-ant-...  → Anthropic (Claude)
//   • sk-...      → OpenAI
function resolveKeys() {
  const val = v => { v = (v || '').trim(); return (v && !v.startsWith('your_')) ? v : null; };
  const fields = [
    process.env.GEMINI_API_KEY,
    process.env.OPENAI_API_KEY,
    process.env.ANTHROPIC_API_KEY,
  ].map(val).filter(Boolean);

  let geminiKey = null, openaiKey = null, anthropicKey = null;
  for (const k of fields) {
    if (k.startsWith('AIza'))       { geminiKey    = geminiKey    || k; }
    else if (k.startsWith('sk-ant')){ anthropicKey = anthropicKey || k; }
    else if (k.startsWith('sk-'))   { openaiKey    = openaiKey    || k; }
  }
  // Also accept a Gemini key that doesn't start with AIza, if it's in GEMINI_API_KEY
  const gk = val(process.env.GEMINI_API_KEY);
  if (!geminiKey && gk && !gk.startsWith('sk-')) geminiKey = gk;
  return { geminiKey, openaiKey, anthropicKey };
}

function hasGeminiKey()    { return !!resolveKeys().geminiKey; }
function hasOpenAIKey()    { return !!resolveKeys().openaiKey; }
function hasAnthropicKey() { return !!resolveKeys().anthropicKey; }

async function client() {
  if (_creditExhausted) return null;
  if (!_clientChecked) {
    _clientChecked = true;
    const { geminiKey, openaiKey, anthropicKey } = resolveKeys();
    // Priority: Gemini (free) → OpenAI → Anthropic
    if (geminiKey) {
      _geminiKey = geminiKey;
      _client = { provider: 'gemini' }; // REST-based; no SDK object needed
      _provider = 'gemini';
      console.log(`[AI] Google Gemini initialized (model: ${GEMINI_MODEL})`);
    } else if (openaiKey) {
      try {
        const { default: OpenAI } = await import('openai');
        _client = new OpenAI({ apiKey: openaiKey });
        _provider = 'openai';
        console.log(`[AI] OpenAI client initialized (model: ${OPENAI_MODEL})`);
      } catch (e) { _client = null; console.error('[AI] OpenAI init failed:', e.message); }
    } else if (anthropicKey) {
      try {
        const { default: Anthropic } = await import('@anthropic-ai/sdk');
        _client = new Anthropic({ apiKey: anthropicKey });
        _provider = 'anthropic';
        console.log('[AI] Anthropic (Claude) client initialized');
      } catch (e) { _client = null; console.error('[AI] Anthropic init failed:', e.message); }
    }
  }
  return _client;
}

// Unified chat call — works for Gemini, OpenAI and Anthropic. Returns plain text.
// `images` (optional): [{ mimeType, data(base64) }] — attached to the last user
// message for vision-capable models (Gemini 2.x, gpt-4o).
async function llmChat({ system, messages, max_tokens = 1000, images = [] }) {
  const ai = await client();
  if (!ai) return null;

  if (_provider === 'gemini') {
    const contents = (messages || []).map(m => ({
      role: m.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: String(m.content ?? '') }]
    }));
    // Attach images to the last user message (Gemini multimodal input)
    if (images?.length) {
      let lastUser = null;
      for (let i = contents.length - 1; i >= 0; i--) { if (contents[i].role === 'user') { lastUser = contents[i]; break; } }
      if (!lastUser) { lastUser = { role: 'user', parts: [{ text: '' }] }; contents.push(lastUser); }
      for (const img of images) {
        if (img?.data) lastUser.parts.push({ inline_data: { mime_type: img.mimeType || 'image/png', data: img.data } });
      }
    }
    const body = {
      contents,
      generationConfig: {
        maxOutputTokens: max_tokens,
        temperature: 0.2,
        // Disable "thinking" so all output tokens go to the answer (2.5 models
        // otherwise spend the budget on internal reasoning and can truncate).
        thinkingConfig: { thinkingBudget: 0 }
      }
    };
    if (system) body.systemInstruction = { parts: [{ text: system }] };
    // Retry transient 503/500 ("high demand"), then fall back to a second model.
    const modelsToTry = GEMINI_MODEL === 'gemini-flash-latest' ? [GEMINI_MODEL] : [GEMINI_MODEL, 'gemini-flash-latest'];
    let lastErr;
    for (const mdl of modelsToTry) {
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          const url = `https://generativelanguage.googleapis.com/v1beta/models/${mdl}:generateContent?key=${_geminiKey}`;
          const resp = await axios.post(url, body, { timeout: 60000, headers: { 'Content-Type': 'application/json' } });
          const parts = resp.data?.candidates?.[0]?.content?.parts || [];
          return parts.map(p => p.text || '').join('') || '';
        } catch (e) {
          lastErr = e;
          const st = e.response?.status;
          if (st === 503 || st === 500) { await new Promise(r => setTimeout(r, 1200)); continue; } // transient → retry
          throw e; // 400/401/403/429 → don't retry here
        }
      }
    }
    throw lastErr;
  }

  if (_provider === 'openai') {
    let oaiMessages = system ? [{ role: 'system', content: system }, ...messages] : [...messages];
    // Attach images to the last user message (gpt-4o vision format)
    if (images?.length) {
      for (let i = oaiMessages.length - 1; i >= 0; i--) {
        if (oaiMessages[i].role === 'user') {
          const parts = [{ type: 'text', text: String(oaiMessages[i].content ?? '') }];
          for (const img of images) if (img?.data) parts.push({ type: 'image_url', image_url: { url: `data:${img.mimeType || 'image/png'};base64,${img.data}` } });
          oaiMessages[i] = { role: 'user', content: parts };
          break;
        }
      }
    }
    const response = await ai.chat.completions.create({
      model: OPENAI_MODEL,
      max_tokens,
      messages: oaiMessages
    });
    return response.choices?.[0]?.message?.content ?? '';
  }

  // anthropic
  const response = await ai.messages.create({
    model: ANTHROPIC_MODEL,
    max_tokens,
    system,
    messages
  });
  return response.content?.[0]?.text ?? '';
}

function handleApiError(e, label) {
  const err = e?.response?.data?.error || {};
  const combined = [
    err?.message || e?.response?.data?.error, e?.message, e?.code, err?.type, err?.code, err?.status
  ].filter(Boolean).map(String).join(' | ');

  // PERMANENT failures only → stop using the LLM this session. Be SPECIFIC:
  //   • OpenAI out of funds  → "insufficient_quota"
  //   • Anthropic out of funds → "credit balance"
  //   • bad/rejected key     → "API key not valid" / "API_KEY_INVALID"
  //   • API disabled/denied  → "SERVICE_DISABLED" / "PERMISSION_DENIED"
  // NOTE: a generic Gemini free-tier RATE LIMIT (429) also mentions "billing",
  // so we must NOT treat "billing" or a bare "exceeded your quota" as permanent.
  if (/insufficient_quota|credit balance|API key not valid|API_KEY_INVALID|api key expired|SERVICE_DISABLED|PERMISSION_DENIED|consumer has been suspended|has not been enabled/i.test(combined)) {
    _creditExhausted = true;
    console.error(`[AI] ${label}: LLM disabled for this session — ${combined.slice(0, 160)}`);
  } else {
    // TRANSIENT (Gemini 429 rate limit / "retry in Ns", timeout, 5xx, network) —
    // log only; keep the LLM enabled so the next question tries again.
    console.error(`[AI] ${label}: (transient) ${combined.slice(0, 200)}`);
  }
}

export function isAIAvailable() {
  if (_creditExhausted) return false;
  return hasGeminiKey() || hasOpenAIKey() || hasAnthropicKey();
}

const MODEL = ANTHROPIC_MODEL; // kept for backward-compat references

// ── MARKDOWN TABLE BUILDER ─────────────────────────────────────────────────
// Builds a clean GFM table. Sanitizes every cell (escapes pipes, strips
// newlines, stringifies objects, truncates huge blobs) and caps the number of
// columns so wide "log" collections (e.g. Activites with a giant Headers field)
// stay readable instead of corrupting the table layout.
function safeJSON(v) { try { return JSON.stringify(v); } catch { return String(v); } }

function mdCell(v, maxLen = 60) {
  if (v === null || v === undefined || v === '') return '—';
  let s = (typeof v === 'object') ? safeJSON(v) : String(v);
  s = s.replace(/[\r\n\t]+/g, ' ')   // no line breaks inside a cell
       .replace(/\|/g, '/')          // pipes would split the cell
       .replace(/\s{2,}/g, ' ')
       .trim();
  if (s.length > maxLen) s = s.slice(0, maxLen - 1) + '…';
  return s || '—';
}

function mdTable(headers, rows, { maxCols = 8, maxRows = 50, maxCell = 60 } = {}) {
  const cols = (headers || []).slice(0, maxCols);
  if (!cols.length) return '';
  const extraCols = (headers || []).length - cols.length;
  const allRows = rows || [];
  // Detect numeric columns (from a sample) so numbers right-align in the table.
  const isNum = v => v !== null && v !== undefined && v !== '' && /^-?[\d,]+(\.\d+)?%?$/.test(String(v).trim());
  const sample = allRows.slice(0, 40);
  const numeric = cols.map((_, i) => {
    const vals = sample.map(r => r[i]).filter(v => v !== null && v !== undefined && v !== '');
    return vals.length > 0 && vals.every(isNum);
  });
  const hdr  = `| ${cols.map(h => mdCell(h, 40)).join(' | ')} |`;
  const sep  = `| ${cols.map((_, i) => (numeric[i] ? '---:' : '---')).join(' | ')} |`;
  const body = allRows.slice(0, maxRows)
    .map(r => `| ${cols.map((_, i) => mdCell(r[i], maxCell)).join(' | ')} |`)
    .join('\n');
  let out = `${hdr}\n${sep}\n${body}`;
  const notes = [];
  if (allRows.length > maxRows) notes.push(`Showing ${maxRows} of **${allRows.length}** rows — open **Raw Results** below for all.`);
  if (extraCols > 0) notes.push(`Showing ${cols.length} of ${headers.length} fields per record.`);
  if (notes.length) out += `\n\n_${notes.join(' ')}_`;
  return out;
}

// Compact catalog text for the LLM planner so it knows all servers/collections.
function buildCatalogText(catalog, currentDbName) {
  if (!catalog?.length) return '';
  const lines = catalog.map(db => {
    const here = db.name === currentDbName ? ' (CURRENTLY SELECTED)' : '';
    const cols = (db.collections || []).slice(0, 40).join(', ');
    const more = (db.collections || []).length > 40 ? `, +${db.collections.length - 40} more` : '';
    return `- ${db.name} [${classifyDatabase(db.name)}]${here}: ${cols}${more}`;
  });
  return `ALL DATABASES/SERVERS AVAILABLE (${catalog.length}):\n${lines.join('\n')}`;
}

// Compact list of saved questions for the LLM planner (prefer ones on this DB).
function buildSavedQueriesText(cards, dbName) {
  if (!cards?.length) return '';
  const onThisDb = dbName ? cards.filter(c => c.dbName === dbName) : [];
  const use = (onThisDb.length ? onThisDb : cards).slice(0, 25);
  const lines = use.map(c => `- "${c.name}"${c.description ? ` — ${c.description.slice(0, 80)}` : ''}${c.collection ? ` [collection: ${c.collection}]` : ''}`);
  return `SAVED METABASE QUESTIONS/QUERIES you can reference (${cards.length} total):\n${lines.join('\n')}`;
}

function buildCompactSchema(schema) {
  const tables = schema?.tables || [];
  if (!tables.length) return 'No collections/tables found.';
  const allNames = tables.map(t => t.name).join(', ');
  const lines = [];
  let chars = 0;
  for (const t of tables) {
    const cols = (t.fields || []).map(f => f.name).join(', ');
    const line = cols ? `${t.name}(${cols})` : t.name;
    if (chars + line.length > 5500) break;
    lines.push(line);
    chars += line.length + 1;
  }
  return `ALL COLLECTIONS: ${allNames}\n\nFIELDS:\n${lines.join('\n')}`;
}

function extractJSON(raw) {
  if (!raw) return null;
  const text = raw.trim();
  // Try direct parse
  try { const o = JSON.parse(text); if (o?.query || o?.sql || o?.pipeline) return o; } catch {}
  // Try JSON in code block
  const cb = text.match(/```(?:json)?\s*([\s\S]+?)\s*```/);
  if (cb) { try { const o = JSON.parse(cb[1]); if (o?.query || o?.sql || o?.pipeline) return o; } catch {} }
  // Extract { } object
  const s = text.indexOf('{'), e = text.lastIndexOf('}');
  if (s !== -1 && e > s) { try { const o = JSON.parse(text.slice(s, e + 1)); if (o?.query || o?.sql || o?.pipeline) return o; } catch {} }
  // SQL fallback
  const sqlMatch = text.match(/\b(SELECT|WITH)\b[\s\S]+?(?=\n\n|$)/i);
  if (sqlMatch) return { sql: sqlMatch[0].trim().replace(/;$/, '') };
  return null;
}

export async function generateSQL(question, schema, history = []) {
  const mongo = isMongoDB(schema);
  const engine = schema?.engine || (mongo ? 'mongo' : 'postgres');
  const tables = schema?.tables || [];

  console.log(`\n[AI] generateSQL: "${question}" | engine=${engine} | tables=${tables.length} | mongo=${mongo}`);

  const ai = await client();

  if (ai) {
    const schemaText = buildCompactSchema(schema);
    const allNames = tables.map(t => t.name).join(', ');

    const systemPrompt = mongo
      ? `You are a MongoDB expert for a CloudFuze migration database.

COLLECTIONS AND FIELDS:
${schemaText}

Generate a MongoDB aggregation pipeline for the question. Return ONLY this JSON (no markdown):
{"query":"[{...}]","collection":"CollectionName","explanation":"what it does","query_type":"aggregate"}

RULES:
- "query" must be a valid stringified JSON array (aggregation pipeline)
- For count questions: use [{"$count":"total"}]
- For status breakdown: use [{"$group":{"_id":"$fieldName","count":{"$sum":1}}},{"$sort":{"count":-1}}]
- For listing: use [{"$limit":100}] or [{"$project":{...}},{"$limit":100}]
- Pick the most relevant collection from: ${allNames}`
      : `You are a SQL expert for a CloudFuze database (engine: ${engine}).

SCHEMA:
${schemaText}

Return ONLY this JSON: {"sql":"SELECT...","explanation":"...","tables_used":["T"],"query_type":"list"}
Use ${engine.includes('mysql') ? 'backticks' : engine.includes('sqlserver') ? 'square brackets' : 'double quotes'} for identifiers.`;

    // Attempt 1: full schema
    try {
      const text = await llmChat({
        max_tokens: 1200,
        system: systemPrompt,
        messages: [{ role: 'user', content: `Question: ${question}` }]
      });
      const raw = (text || '').trim();
      console.log('[AI] Attempt 1 raw:', raw.substring(0, 200));
      const result = extractJSON(raw);
      if (result) {
        if (mongo && result.query && result.collection) {
          console.log('[AI] Attempt 1 MongoDB SUCCESS: collection=' + result.collection);
          return { query: result.query, collection: result.collection, explanation: result.explanation || '', tables_used: [result.collection], query_type: result.query_type || 'list', isMongo: true };
        } else if (!mongo && result.sql) {
          console.log('[AI] Attempt 1 SQL SUCCESS:', result.sql.substring(0, 80));
          return { sql: result.sql, explanation: result.explanation || '', tables_used: result.tables_used || [], query_type: result.query_type || 'list', isMongo: false };
        }
      }
    } catch (e) { handleApiError(e, 'Attempt 1'); }

    // Attempt 2: simpler prompt
    if (!_creditExhausted) {
      try {
        const prompt2 = mongo
          ? `Return MongoDB aggregation pipeline JSON for: "${question}"\nCollections: ${allNames}\nFormat: {"query":"[{...}]","collection":"Name"}`
          : `Return SQL JSON for: "${question}"\nTables: ${allNames}\nFormat: {"sql":"SELECT..."}`;
        const text = await llmChat({
          max_tokens: 600,
          system: 'Return ONLY raw JSON. No markdown. No explanation.',
          messages: [{ role: 'user', content: prompt2 }]
        });
        const result = extractJSON((text || '').trim());
        if (result) {
          if (mongo && result.query) return { query: result.query, collection: result.collection || tables[0]?.name, explanation: result.explanation || '', tables_used: [], query_type: 'list', isMongo: true };
          if (!mongo && result.sql) return { sql: result.sql, explanation: '', tables_used: [], query_type: 'list', isMongo: false };
        }
      } catch (e) { handleApiError(e, 'Attempt 2'); }
    }
  }

  // Keyword fallback — always works, no AI needed
  console.log('[AI] Using keyword fallback (credits exhausted or AI unavailable)');
  const fallback = mongo ? buildMongoQuery(question, schema) : buildKeywordSQL(question, schema);
  if (fallback) return fallback;

  throw new Error('No tables/collections found in schema. Please select a database first.');
}

// ═══ SUPER AGENT: LLM-powered intent planner + answer synthesizer ══════════
// Compact schema + REAL sample values so the LLM picks the right collection
// and writes correct field names.
function buildRichSchema(schema, scanData = new Map()) {
  const tables = schema?.tables || [];
  const lines = [];
  let chars = 0;
  for (const t of tables) {
    const fieldNames = (t.fields || []).map(f => f.name);
    const scan = scanData.get?.(t.name);
    let line = `• ${t.name}${typeof scan?.docCount === 'number' ? ` (${scan.docCount} docs)` : ''} — fields: ${fieldNames.join(', ')}`;
    if (scan?.sampleValues) {
      const samples = [];
      for (const [field, vals] of Object.entries(scan.sampleValues)) {
        if (vals && vals.length && samples.length < 5) {
          samples.push(`${field}="${String(vals[0]).slice(0, 35)}"`);
        }
      }
      if (samples.length) line += `\n    e.g. ${samples.join(', ')}`;
    }
    // Ground-truth status vocabulary (real distinct values + counts from the deep
    // scan). Lets the planner map ANY phrasing ("migrated"/"done"/"transferred")
    // to the value this collection actually stores, and know the true breakdown.
    if (scan?.statusField && Array.isArray(scan.statusValues) && scan.statusValues.length) {
      const vals = scan.statusValues.slice(0, 12).map(sv => `${sv.value}=${sv.count}`).join(', ');
      line += `\n    ${scan.statusField} values: ${vals}`;
    }
    if (chars + line.length > 8500) {
      lines.push(`…and ${tables.length - lines.length} more collections.`);
      break;
    }
    lines.push(line);
    chars += line.length + 1;
  }
  return lines.join('\n');
}

function extractPlanJSON(raw) {
  if (!raw) return null;
  const text = String(raw).trim();
  const tryParse = s => { try { const o = JSON.parse(s); if (o && o.sub_questions) return o; } catch {} return null; };
  const cb = text.match(/```(?:json)?\s*([\s\S]+?)\s*```/);
  const s = text.indexOf('{'), e = text.lastIndexOf('}');
  return tryParse(text)
      || (cb ? tryParse(cb[1]) : null)
      || ((s !== -1 && e > s) ? tryParse(text.slice(s, e + 1)) : null);
}

// Decompose the user's message into intent-tagged sub-questions, each with a
// ready-to-run query when data is needed. Returns null if no LLM is available.
export async function planWithLLM(question, schema, scanData = new Map(), history = [], catalog = [], savedQueries = []) {
  const ai = await client();
  if (!ai) return null;

  const mongo = isMongoDB(schema);
  const schemaText = buildRichSchema(schema, scanData);
  const catalogText = buildCatalogText(catalog, schema?.name);
  const savedText = buildSavedQueriesText(savedQueries, schema?.name);
  const hasHistory = (history || []).some(h => h?.content);
  const today = new Date().toISOString().slice(0, 10);
  // Keyword-ranked best-fit collections — a strong hint so the LLM doesn't pick
  // a wrong-but-plausible collection (e.g. MessageJob when asked about workspaces).
  const ranked = getTopCollections(question, schema, 6, scanData).map(t => t.name);

  const system = `You are the reasoning brain of the CloudFuze Migration Intelligence assistant.
CloudFuze migrates messages, files, channels and users between cloud platforms (Slack, Microsoft Teams, Google Chat, OneDrive, SharePoint, Box, Dropbox, etc.).
The database engine is ${mongo ? 'MongoDB — write aggregation pipelines' : 'SQL'}.

A single user message may contain ONE OR MORE questions. Break it into sub-questions and plan how to answer each one.
${catalogText ? `\n${catalogText}\nIMPORTANT: You can only QUERY the currently-selected database. If the user asks about data that lives in a DIFFERENT database, use intent "cross_database" and name the database they should switch to.\n` : ''}${savedText ? `\n${savedText}\n` : ''}
AVAILABLE COLLECTIONS in the SELECTED database (name — fields, with real sample values):
${schemaText}

Choose an intent for each sub-question:
- "data_query": fetch/aggregate real data (counts, lists, status breakdowns, a SPECIFIC workspace/user/channel by id or name, "why did X fail / go to conflict", who the collaborators are, message/file counts, etc.)
- "schema_explain": explain what a collection stores / its purpose (no data fetch)
- "schema_list": list the available collections (no data fetch)
- "list_databases": list the available databases/servers (no data fetch)
- "cross_database": the data is in a DIFFERENT database than the one selected — set "database" to the one to switch to
- "documentation": a PRODUCT / how-to / "how does CloudFuze do X" question answerable from the product docs (NOT a database lookup)
- "general_knowledge": explain a CloudFuze / migration concept (no data fetch)

For every data_query, ALSO classify the OPERATION — this is how you make DIFFERENT PHRASINGS of the same question resolve identically:
- "count"     → how many / count / total / tally / number of  (e.g. "how many users", "give me the tally of workspaces")
- "list"      → list / show / give me all / everyone / the complete set
- "breakdown" → group by status / status breakdown / distribution / how many in each status
- "why"       → why did it fail/conflict / reason / cause / what went wrong
- "filter"    → only the ones matching ONE status/value (failed, conflict, active, inactive, pending…); put that value in "filter_value"
- "specific"  → a specific record by id / name / email
Set "filter_value" to the status the user named. Map their WORDING to the real status:
    migrated / completed / successful / done → "processed"
    not migrated / pending / remaining / incomplete / left → "not processed"
    failed / errored → "failed" ;  in conflict → "conflict" ;  active → "active" ;  inactive → "inactive"

IMPORTANT — full report / multiple statuses:
- If the user asks for SEVERAL statuses at once (e.g. "how many migrated, not migrated, and in conflict") or a full status picture, use a SINGLE sub-question with operation:"breakdown" — it returns EVERY status with its count in one shot. Do NOT create a separate count sub-question per status.
- If they ALSO want the conflict/failure REASONS, add exactly ONE more sub-question with operation:"why".
- So a "give me everything for workspace X" request = 2 sub-questions: one "breakdown" + one "why".

Return ONLY JSON (no markdown, no prose):
{"sub_questions":[{"text":"the sub-question","intent":"data_query|schema_explain|schema_list|list_databases|cross_database|documentation|general_knowledge","operation":"count|list|breakdown|why|filter|specific|null","filter_value":"value or null","collection":"ExactCollectionNameOrNull","database":"DbNameOrNull","query":"stringified pipeline or null","note":"one line"}]}

MONGODB QUERY RULES (when intent is data_query):
- "query" MUST be a STRINGIFIED JSON array, e.g. "[{\\"$match\\":{\\"UniqueWorkSpaceId\\":\\"abc123\\"}},{\\"$limit\\":10}]"
- Specific workspace/user/channel by ID → $match on that id field, then $limit 10
- Match by NAME (case-insensitive) → {"FieldName":{"$regex":"value","$options":"i"}}
- Count → [{"$count":"total"}]
- Status/breakdown → [{"$group":{"_id":"$StatusField","count":{"$sum":1}}},{"$sort":{"count":-1}}]
- Always add {"$limit":N} (N ≤ 100) for list queries
- Use EXACT field names shown above.

CHOOSING THE RIGHT COLLECTION (critical for correct answers):
- Most-relevant collections for THIS question, ranked best-first: ${ranked.join(', ') || '(none)'}
- Strongly prefer the FIRST ranked collection whose fields fit. Match the collection to the ENTITY asked about:
    "workspace(s)" → a *WorkSpace collection (e.g. MessageWorkSpace / emailWorkSpace) — NOT a Job/Queue/Log/Stats collection.
    "message(s)"   → a Message* collection.   "user(s)/agent(s)/member(s)" → a Users/Agent/Member collection.
    "channel(s)"   → a Channel collection.    "job(s)" → a Job collection.   "file(s)/folder(s)" → a File/Folder collection.
- NEVER answer a "how many workspaces" question from a Job/Queue/Stats collection. Count workspaces from the WorkSpace collection.
- For counts use the SAME collection you'd list from, so the number matches reality.

CONVERSATION MEMORY (today is ${today}):
- The messages above are prior turns. If the NEW message is a FOLLOW-UP that only makes sense with that context — e.g. "only today's", "what about the failed ones", "now show their owners", "just the conflict ones", "those", "the same for yesterday" — you MUST resolve it against the previous turn.
- REWRITE each sub-question's "text" to be COMPLETE and self-contained: carry forward the ENTITY, COLLECTION and any FILTERS from the previous turn, then apply the new refinement. Example: prev "show failed workspaces" + new "only today's" → text: "failed workspaces from today", collection: same as before.
- Keep the SAME "collection" as the previous turn unless the entity itself changed.
- Resolve relative dates against today (${today}): "today" = ${today}; "yesterday" = the day before; "last 7 days" = the past week.`;

  const messages = [];
  for (const h of (history || []).slice(-6)) {
    if (!h?.content) continue;
    messages.push({ role: h.role === 'assistant' ? 'assistant' : 'user', content: String(h.content).slice(0, 500) });
  }
  messages.push({ role: 'user', content: question });

  try {
    const text = await llmChat({ max_tokens: 1600, system, messages });
    const plan = extractPlanJSON(text);
    if (plan?.sub_questions?.length) {
      plan.sub_questions = plan.sub_questions.slice(0, 6); // sanity clamp
      return plan;
    }
    return null;
  } catch (e) {
    handleApiError(e, 'planWithLLM');
    return null;
  }
}

// Combine all gathered sub-answers/data into one human, elaborate response.
export async function synthesizeAnswer(originalQuestion, parts, history = []) {
  const staticJoin = () => parts.map(p => {
    const head = parts.length > 1 ? `### ${p.text}\n` : '';
    if (p.rows && p.headers && p.rows.length) {
      return `${head}Found **${p.rows.length} record(s)** in **${p.collection}**:\n\n${mdTable(p.headers, p.rows)}`;
    }
    if (p.staticAnswer) return head + p.staticAnswer;
    return head + `No data found in **${p.collection || 'the database'}**.`;
  }).filter(Boolean).join('\n\n---\n\n');

  // Anti-hallucination guard: if NOTHING was actually retrieved (no rows and no
  // real static answer), do NOT ask the LLM to "write an answer" — it would
  // invent data. Return an honest message instead.
  const hasRealData = parts.some(p => (p.rows && p.rows.length) || (p.staticAnswer && p.staticAnswer.trim()));
  if (!hasRealData) {
    return `I couldn't retrieve any data for **"${originalQuestion}"** — the database query returned nothing or the connection timed out. Please try again in a moment, or rephrase your question. I won't guess at an answer without real data.`;
  }

  // ── FAST PATH: a single scalar COUNT needs no LLM to phrase ──
  // Only a PURE scalar ($count → one row, one cell). A grouped row like
  // [status, count] or [errorDescription, count] must NOT collapse to its count —
  // the label (the status/reason) is the answer the user wants, so those go to
  // the full synthesis below. This is what makes "why did it conflict" show the
  // real reason instead of "1".
  if (parts.length === 1) {
    const p = parts[0];
    const oneRow = p.rows && p.rows.length === 1 ? p.rows[0] : null;
    const scalar = (oneRow && oneRow.length === 1) ? oneRow[0] : null;
    // Don't fast-path "why/reason" questions — they need the reason text rendered.
    const isWhy = isReasonQuestion(originalQuestion || '');
    if (!isWhy && p.intent === 'data_query' && scalar != null && (typeof scalar === 'number' || /^\d+$/.test(String(scalar)))) {
      const n = typeof scalar === 'number' ? scalar : parseInt(scalar, 10);
      return `**${n.toLocaleString('en-US')}** — that's the exact count for _"${(originalQuestion || '').trim()}"_ (from the \`${p.collection}\` collection).\n\nAsk for a **breakdown** or the **conflict/failure reasons** if you'd like more detail.`;
    }
  }

  // LARGE LIST → render the FULL table deterministically. The LLM only receives
  // a sample, so it would silently truncate a long list. This guarantees the
  // user gets EVERY row they asked for (e.g. all 91 users, or all 1000).
  const maxRows = Math.max(0, ...parts.map(p => (p.rows?.length || 0)));
  if (maxRows > 20) {
    return parts.map(p => {
      const head = parts.length > 1 ? `### ${p.text}\n` : '';
      if (p.rows && p.headers && p.rows.length) {
        return `${head}**${p.rows.length} record${p.rows.length !== 1 ? 's' : ''}** found in **${p.collection}**:\n\n${mdTable(p.headers, p.rows, { maxCols: 10, maxRows: 2000, maxCell: 60 })}`;
      }
      if (p.staticAnswer) return head + p.staticAnswer;
      return '';
    }).filter(Boolean).join('\n\n---\n\n');
  }

  const ai = await client();
  if (!ai) return staticJoin();

  const ctx = parts.map((p, i) => {
    let block = `[Sub-question ${i + 1}] ${p.text}\nintent=${p.intent}${p.collection ? ` collection=${p.collection}` : ''}`;
    if (p.rows && p.headers) {
      const sample = p.rows.slice(0, 30).map(r => p.headers.reduce((o, h, idx) => ({ ...o, [h]: r[idx] }), {}));
      block += `\nROW_COUNT=${p.rows.length}\nDATA=${JSON.stringify(sample).slice(0, 5000)}`;
    } else if (p.staticAnswer) {
      block += `\nINFO=${p.staticAnswer.slice(0, 1500)}`;
    } else {
      block += `\nDATA=(none returned)`;
    }
    return block;
  }).join('\n\n');

  const system = `You are the CloudFuze Migration Intelligence assistant. Write a clear, human answer.

⛔ ABSOLUTE RULE — ACCURACY OVER FLUENCY:
- Use ONLY the values in "Gathered information" below. NEVER invent counts, workspace names, statuses, emails, dates, or table rows.
- If a sub-question's DATA is "(none returned)" or INFO says it timed out/failed, say plainly that you could not retrieve it — do NOT make up a plausible answer.
- The count you state MUST equal ROW_COUNT (or the actual number/value in the data). Do not round or estimate.
- If DATA is a status breakdown (rows of [status, count]), report each status with its EXACT count and the true total (sum of counts).

FORMAT:
- Multiple sub-questions → answer EACH under its own bold heading.
- Lead with the key fact in bold, then a short plain-English explanation.
- Show multi-row data as a markdown table. Never paste raw JSON.

WHEN THE DATA CONTAINS ERRORS / CONFLICT REASONS (e.g. a "why did it fail/conflict" question):
- List the ACTUAL error/reason values from the data — do not summarize them away.
- For EACH distinct error, add a plain-English "what it means & how to fix" in business terms. Use this glossary:
    • Conflict / "already exists" → A file/folder/message with the same name already exists at the destination, so it was skipped to avoid overwriting. Resolve by renaming, merging, or running a delta migration.
    • BadRequest / "special character" / invalid name → The name has characters the destination doesn't allow (e.g. \\ / : * ? " < > |). Rename the item and retry.
    • Forbidden / 403 / "access denied" → The account lacks permission to read the source or write to the destination. Re-authorize or grant the needed scopes/permissions.
    • Unauthorized / 401 / token expired → OAuth tokens expired or are invalid — reconnect the source/destination account.
    • NotFound / 404 → The source item was moved or deleted before migration.
    • Timeout / timed out → The item/channel was too large or the network too slow; retry, ideally off-peak.
    • RateLimit / throttled / 429 → The destination API throttled the transfer; it will retry at a slower pace.
    • DatabaseError / DataAccessResourceFailureException → A backend datastore error during migration; usually transient — retry.
    • NO_MESSAGE → The source channel/workspace was empty, so nothing was migrated (not a real failure).
    • Quota / storage full → The destination account is out of storage; free space or upgrade, then retry.
    • "Missing entry in CFOAuthCredential" / missing credential / not mapped → The user shown (see the email in the message) isn't set up/authorized in CloudFuze's credential store, so their items couldn't be migrated. Add or re-authorize that user's account mapping (map the email to a valid destination account), then re-run the migration.
  If an error isn't in this list, explain it sensibly from its wording — but NEVER invent an error that isn't in the data.
- ALWAYS quote the EXACT error text (e.g. the full ErrorDescription value, including any email/id it mentions) and THEN give the plain-English meaning right after it. The user wants the real reason, verbatim, translated.
- Status meanings: PROCESSED = completed; PROCESSED_WITH_SOME_CONFLICTS = done but some items conflicted; CONFLICT = blocked by an existing item; FAILED/ERROR = errored; IN_PROGRESS = still running; NO_MESSAGE = source empty.`;

  try {
    const text = await llmChat({
      max_tokens: 2200,
      system,
      messages: [{ role: 'user', content: `User asked: "${originalQuestion}"\n\nGathered information (this is the ONLY data you may use):\n\n${ctx}\n\nWrite the answer using only this data.` }]
    });
    return text || staticJoin();
  } catch (e) {
    handleApiError(e, 'synthesizeAnswer');
    return staticJoin();
  }
}

// ── RAG: answer a product/how-to question from the documentation ──────────
// Retrieves the most relevant doc chunks and answers STRICTLY from them, with
// citations. Returns null if no LLM, or a "not in docs" note if nothing matched.
export async function answerFromDocs(question) {
  // Prefer SEMANTIC (vector) retrieval — matches paraphrases/synonyms. Falls back
  // to keyword search when embeddings are unavailable or return nothing.
  let chunks = null;
  try { chunks = await searchDocsSemantic(question, 4); } catch { chunks = null; }
  if (!chunks || !chunks.length) chunks = searchDocs(question, 4);
  if (!chunks.length) return null; // no relevant docs — caller falls back
  const ai = await client();
  if (!ai) {
    // No LLM → return the most relevant snippet directly, with its source.
    return `From the documentation (**${chunks[0].source}**):\n\n${chunks[0].text}`;
  }
  const context = chunks.map((c, i) => `[${i + 1}] source: ${c.source}\n${c.text}`).join('\n\n---\n\n');
  const system = `You are the CloudFuze assistant answering from the product DOCUMENTATION below.
- Answer ONLY using the documentation provided. Do NOT use outside knowledge or invent details.
- If the documentation doesn't contain the answer, say so plainly and suggest what to ask instead.
- Cite the source file in parentheses, e.g. (cloudfuze-overview.md).
- Be clear and concise.`;
  try {
    const text = await llmChat({
      max_tokens: 1200,
      system,
      messages: [{ role: 'user', content: `DOCUMENTATION:\n\n${context}\n\nQUESTION: ${question}\n\nAnswer using only the documentation above.` }]
    });
    return text || `From the documentation (**${chunks[0].source}**):\n\n${chunks[0].text}`;
  } catch (e) {
    handleApiError(e, 'answerFromDocs');
    return `From the documentation (**${chunks[0].source}**):\n\n${chunks[0].text}`;
  }
}

// Answer a question about one or more attached images (screenshots of the
// Metabase dashboard, a collection, an error, migration data, etc.) using the
// vision-capable LLM. Returns null if no LLM is available.
export async function answerVisionQuestion(question, images, schema, scanData = new Map()) {
  const ai = await client();
  if (!ai) return null;
  if (_provider === 'anthropic') {
    // Anthropic vision uses a different payload we don't build here — be honest.
    return null;
  }

  const collections = (schema?.tables || []).map(t => t.name);
  const collectionsHint = collections.slice(0, 60).join(', ');

  const system = `You are the CloudFuze Migration Intelligence assistant with vision.
The user attached one or more images — usually a screenshot of the Metabase dashboard, a collection's documents, a migration status, an error message, or query results.

Analyze the image(s) carefully and answer the user's question in clear, human, plain English.
- If it shows a collection or documents, explain what the data means in CloudFuze migration terms (workspaces, messages, files, users, statuses).
- If it shows an error or a failed/conflict status, explain likely WHY and what it means.
- If the user asks "what is this" with no specifics, describe what the screenshot shows and its significance.
- Be specific and reference the actual values you can see. Do not invent data you cannot see.

Collections in the currently selected database (for context): ${collectionsHint}.`;

  try {
    const text = await llmChat({
      max_tokens: 1500,
      system,
      messages: [{ role: 'user', content: question?.trim() || 'Explain what this screenshot shows and what it means for the migration.' }],
      images
    });
    return text || null;
  } catch (e) {
    handleApiError(e, 'answerVisionQuestion');
    return null;
  }
}

export async function interpretResults(question, queryInfo, metabaseResult) {
  const data = metabaseResult?.data || {};
  const cols = data.cols || [];
  const rows = data.rows || [];
  const headers = cols.map(c => c.display_name || c.name);

  const subject = queryInfo?.collection || (queryInfo?.tables_used?.[0]) || 'records';

  const isWhy = isReasonQuestion(question);
  const specificFilter = extractSpecificFilter(question);
  const specificId = specificFilter?.value || null;

  // Always build a plain summary — works with zero AI credits
  function plainSummary() {
    if (rows.length === 0) {
      if (specificId) {
        return `I looked through the **${subject}** collection but couldn't find any records for the ID \`${specificId}\`.\n\nThis could mean the ID doesn't exist in this collection, or the records have already been cleaned up. Try checking a related collection.`;
      }
      return `I searched through **${subject}** but didn't find any matching records.\n\nPossible reasons:\n- The collection may be empty\n- The search criteria didn't match any records\n- Try rephrasing your question, or ask about a different collection`;
    }

    // ── "WHY" grouped results (error reasons grouped by type) ─────────────
    if (isWhy && rows.length > 0) {
      const idIdx    = headers.findIndex(h => h === '_id');
      const countIdx = headers.findIndex(h => h === 'count');

      if (idIdx !== -1 && countIdx !== -1) {
        const totalErrors = rows.reduce((s, r) => s + (Number(r[countIdx]) || 1), 0);
        const reasonLines = rows.map(r => {
          const reason = r[idIdx] || 'Unknown reason';
          const cnt    = r[countIdx] || 1;
          return `- **${reason}** — happened **${cnt}** time${Number(cnt) !== 1 ? 's' : ''}`;
        }).join('\n');
        const idLabel = specificId ? ` with ID \`${specificId}\`` : '';
        return `The workspace${idLabel} ran into **${totalErrors} error${totalErrors !== 1 ? 's' : ''}** across **${rows.length}** distinct reason${rows.length !== 1 ? 's' : ''}. Here's the breakdown:\n\n${reasonLines}\n\n> These error messages were returned by the destination cloud platform during the migration process.`;
      }

      const errorIdx = headers.findIndex(h => /error|reason|cause|message|detail/i.test(h));
      if (errorIdx !== -1) {
        const reasons = [...new Set(rows.map(r => r[errorIdx]).filter(v => v && v !== 'NULL'))];
        const reasonLines = reasons.slice(0, 20).map(r => `- ${r}`).join('\n');
        const idLabel = specificId ? ` for workspace \`${specificId}\`` : '';
        return `I found **${rows.length} conflict records**${idLabel} in **${subject}**. Here are the reasons why the conflicts occurred:\n\n${reasonLines}${reasons.length > 20 ? `\n\n_...and ${reasons.length - 20} more unique reasons._` : ''}`;
      }
    }

    // ── Single scalar result (count / total) ──────────────────────────────
    if (rows.length === 1 && cols.length === 1) {
      const val = rows[0][0] ?? 0;
      const colName = (headers[0] || '').toLowerCase();
      if (/count|total|num|sum/i.test(colName) || typeof val === 'number') {
        return `There are **${Number(val).toLocaleString('en-US')} records** in the **${subject}** collection.`;
      }
      return `**Answer:** ${val}`;
    }

    // ── Single row — fully dynamic intelligent display ────────────────────
    if (rows.length === 1) {
      const record = {};
      headers.forEach((h, i) => { record[h] = rows[0][i]; });
      const nonEmpty = v => v !== null && v !== undefined &&
                            String(v).trim() !== '' && String(v) !== 'null' &&
                            String(v) !== 'NULL' && String(v) !== 'empty' && String(v) !== 'undefined';

      const allFields = headers.filter(h => nonEmpty(record[h]));
      const q = question.toLowerCase();

      // Helper: find first matching field value
      const fv = (...names) => {
        for (const n of names) {
          const key = allFields.find(f => f.toLowerCase() === n.toLowerCase());
          if (key) return record[key];
          const partial = allFields.find(f => f.toLowerCase().includes(n.toLowerCase()));
          if (partial) return record[partial];
        }
        return null;
      };

      // ── ELABORATE NARRATIVE ANSWER ────────────────────────────────────────
      // Builds a multi-sentence paragraph tailored to what was asked
      function elaborateAnswer() {
        const wsName    = fv('WorkSpaceName','workspacename','Name','name');
        const fromCloud = fv('FromCloudName','SourceCloud','fromcloud');
        const toCloud   = fv('ToCloudName','DestCloud','tocloud');
        const channel   = fv('ChannelName','channelname');
        const combo     = fv('Combination','combination');
        const mType     = fv('Type','type');
        const idRef     = specificId ? ` for workspace \`${specificId}\`` : '';

        // ── ERROR / WHAT IS WRONG ──────────────────────────────────────────
        if (/error|what.*wrong|why.*fail|fail.*reason|error.*desc|issue|problem/.test(q)) {
          const errDesc  = fv('ErrorDescription','errorDescription','UserError','userErrorMessage','Error','failReason','conflictReason');
          const status   = fv('ProcessStatus','Status','status');
          const total    = fv('TotalMessage','TotalFiles');

          if (!errDesc) return null;

          let out = `**Error Details${idRef}**\n\n`;
          if (wsName || fromCloud) {
            out += `This migration`;
            if (wsName)           out += ` for workspace **"${wsName}"**`;
            if (fromCloud && toCloud) out += ` (migrating **${fromCloud} → ${toCloud}**)`;
            if (channel)          out += ` on channel **"${channel}"**`;
            out += ' has logged the following error:\n\n';
          }
          out += `> **"${errDesc}"**\n\n`;

          if (status) {
            out += `The current process status is **${status}**`;
            if (status === 'NO_MESSAGE' || (total !== null && Number(total) === 0))
              out += ', which means the system checked the source but found no messages or files to migrate — the channel/workspace was empty at the time of migration.';
            else if (/fail/i.test(status))
              out += '. This is a failure state — the migration did not complete and needs to be investigated.';
            else if (/conflict/i.test(status))
              out += '. A conflict was detected, meaning the content may already exist at the destination or there was a collision during transfer.';
            else if (/progress|running|active/i.test(status))
              out += '. The migration is still in progress.';
            else
              out += '.';
            out += '\n\n';
          }

          // Contextual explanation based on the error text
          const err = String(errDesc).toLowerCase();
          if (/no message|not found|empty|nothing/i.test(err))
            out += '**What this means:** The source channel had no messages to migrate. This is not a critical failure — it simply means the workspace/channel was empty or had already been processed.\n\n';
          else if (/permission|access|authoriz|forbidden|401|403/i.test(err))
            out += '**What this means:** The system lacked sufficient permissions to read from the source or write to the destination. The OAuth tokens or API credentials for this workspace may need to be refreshed or re-authorized.\n\n';
          else if (/already exist|duplicate|conflict/i.test(err))
            out += '**What this means:** The content already exists at the destination. The migration detected a conflict — the data was not overwritten. This may require manual resolution or a delta migration strategy.\n\n';
          else if (/timeout|timed out|time.?out/i.test(err))
            out += '**What this means:** The migration operation timed out, likely due to a very large channel or slow network. Retrying the migration or increasing the timeout limit may resolve this.\n\n';
          else if (/rate.?limit|throttl|quota/i.test(err))
            out += '**What this means:** The destination platform\'s API rate limit was hit during migration. The system may need to retry with a slower pace or during off-peak hours.\n\n';
          else
            out += '**What this means:** The destination platform returned this error during the migration process. Review the source and destination configuration for this workspace to investigate further.\n\n';

          return out;
        }

        // ── STATUS ─────────────────────────────────────────────────────────
        if (/status|what.*status|current.*status|process.*status|migration.*status|how.*going|progress/.test(q)) {
          const procStatus   = fv('ProcessStatus','Status','status');
          const threadStatus = fv('ThreadStatus','threadstatus');
          const halt         = fv('HaltMigration','haltmigration');
          const deltaMsg     = fv('DeltaMessagesAvailable');
          const processed    = fv('ProcessedCount');
          const total        = fv('TotalMessage');
          const inProgress   = fv('InProgressCount');
          const conflict     = fv('ConflictCount');
          const warning      = fv('WarningCount');

          if (!procStatus && !threadStatus) return null;

          let out = `**Migration Status Report${idRef}**\n\n`;
          if (wsName || fromCloud) {
            out += `Migration`;
            if (wsName)               out += ` for workspace **"${wsName}"**`;
            if (fromCloud && toCloud) out += ` (${fromCloud} → ${toCloud})`;
            out += ':\n\n';
          }

          if (procStatus) {
            out += `- **Process Status: ${procStatus}**`;
            if (procStatus === 'NO_MESSAGE')               out += ' — No messages were found in the source to migrate.';
            else if (/complete|success|done/i.test(procStatus)) out += ' — The migration completed successfully.';
            else if (/fail/i.test(procStatus))             out += ' — Migration failed. Needs attention.';
            else if (/progress|running|active/i.test(procStatus)) out += ' — Migration is currently active and running.';
            else if (/pause/i.test(procStatus))            out += ' — Migration is paused.';
            else if (/queue|wait/i.test(procStatus))       out += ' — Queued and waiting to start.';
            out += '\n';
          }
          if (threadStatus) {
            out += `- **Thread Status: ${threadStatus}**`;
            if (threadStatus === 'RESUME') out += ' — The thread is ready to resume or has been resumed after a pause.';
            out += '\n';
          }
          if (halt === true || halt === 'true') out += `- **Halt Migration: Yes** — This migration has been manually halted.\n`;
          if (deltaMsg)                         out += `- **Delta Messages Available: ${deltaMsg}**\n`;

          if (total !== null || processed !== null) {
            out += '\n**Progress Breakdown:**\n';
            if (total     !== null) out += `- Total messages: **${total}**\n`;
            if (processed !== null) {
              out += `- Processed: **${processed}**`;
              if (total > 0) out += ` (${Math.round((Number(processed)/Number(total))*100)}% complete)`;
              out += '\n';
            }
            if (inProgress !== null && Number(inProgress) > 0) out += `- In Progress: **${inProgress}**\n`;
            if (conflict   !== null && Number(conflict)   > 0) out += `- Conflicts: **${conflict}**\n`;
            if (warning    !== null && Number(warning)    > 0) out += `- Warnings: **${warning}**\n`;
          }
          return out;
        }

        // ── COLLABORATORS / OWNER / EMAILS ────────────────────────────────
        if (/collaborat|from.*user|from.*mail|source.*email|owner|who.*from|who.*to|email.*pair|source.*owner|who.*involv|who.*migrat/.test(q)) {
          const ownerEmail = fv('OwnerEmailId','owneremail','Owner');
          const fromMail   = fv('FromMailId','fromemail','SourceEmail');
          const toMail     = fv('ToMailId','toemail','DestEmail');
          const emailPairs = fv('EmailPairs','emailpairs');
          const userId     = fv('UserId','userid');

          if (!ownerEmail && !fromMail && !toMail) return null;

          let out = `**Users & Collaborators Involved${idRef}**\n\n`;
          if (wsName) out += `For workspace **"${wsName}"**:\n\n`;

          if (ownerEmail)
            out += `- **Workspace Owner / Admin:** ${ownerEmail}\n  This person owns or manages this migration workspace. They are typically responsible for authorizing the migration and resolving any issues.\n\n`;
          if (fromMail)
            out += `- **Source Account (${fromCloud || 'Source Platform'}):** ${fromMail}\n  This is the user account being migrated FROM — the original account on the source platform.\n\n`;
          if (toMail)
            out += `- **Destination Account (${toCloud || 'Destination Platform'}):** ${toMail}\n  This is the user account being migrated TO — the target account at the destination platform.\n\n`;
          if (emailPairs) {
            const pairs = typeof emailPairs === 'string' ? emailPairs : JSON.stringify(emailPairs, null, 2);
            out += `- **Email Pairs (Source ↔ Destination):**\n\`\`\`\n${pairs}\n\`\`\`\n  These are the mapped source-to-destination email pairs for this migration.\n\n`;
          }
          if (userId) out += `- **Internal User ID:** ${userId}\n`;
          return out;
        }

        // ── SOURCE / DESTINATION CLOUD ────────────────────────────────────
        if (/source.*cloud|from.*cloud|which.*source|where.*from|dest.*cloud|to.*cloud|which.*dest|where.*to|migration.*route|which.*cloud/.test(q)) {
          const fromMail = fv('FromMailId','fromemail');
          const toMail   = fv('ToMailId','toemail');

          if (!fromCloud && !toCloud) return null;

          let out = `**Migration Route Details${idRef}**\n\n`;
          if (wsName) out += `For workspace **"${wsName}"**:\n\n`;

          out += `This is a **${fromCloud || '?'} → ${toCloud || '?'}** migration`;
          if (combo) out += ` (Combination type: **${combo}**)`;
          if (mType) out += `, classified as **${mType}**`;
          out += '.\n\n';

          if (fromMail || toMail) {
            out += '**Account Mapping:**\n';
            if (fromMail) out += `- Source (${fromCloud}): **${fromMail}**\n`;
            if (toMail)   out += `- Destination (${toCloud}): **${toMail}**\n`;
            out += '\n';
          }
          if (channel) out += `**Channel being migrated:** "${channel}"${fv('ChannelType') ? ` (type: ${fv('ChannelType')})` : ''}\n\n`;
          return out;
        }

        // ── MESSAGE / FILE COUNTS ─────────────────────────────────────────
        if (/message.*count|total.*message|how.*many.*msg|count|total|how.*many|file.*count/.test(q)) {
          const total      = fv('TotalMessage','totalmessage');
          const processed  = fv('ProcessedCount','processedcount');
          const notProc    = fv('NotProcessedCount','notprocessedcount');
          const inProgress = fv('InProgressCount','inprogresscount');
          const conflict   = fv('ConflictCount','conflictcount');
          const warning    = fv('WarningCount','warningcount');
          const suspended  = fv('SuspendedCount','suspendedcount');
          const files      = fv('TotalFiles','totalfiles');

          if (total === null && processed === null && files === null) return null;

          let out = `**Message & File Migration Counts${idRef}**\n\n`;
          if (wsName) out += `For workspace **"${wsName}"**:\n\n`;

          if (total   !== null) out += `- **Total Messages to Migrate:** ${total}\n`;
          if (files   !== null) out += `- **Total Files to Migrate:** ${files}\n`;
          if (processed !== null) {
            out += `- **Successfully Processed:** ${processed}`;
            if (total > 0) out += ` — that is **${Math.round((Number(processed)/Number(total))*100)}%** of total`;
            out += '\n';
          }
          if (notProc    !== null && Number(notProc)    > 0) out += `- **Not Yet Processed:** ${notProc}\n`;
          if (inProgress !== null && Number(inProgress) > 0) out += `- **Currently In Progress:** ${inProgress} items\n`;
          if (conflict   !== null && Number(conflict)   > 0) out += `- **Conflicts:** ${conflict} items encountered conflicts during migration\n`;
          if (warning    !== null && Number(warning)    > 0) out += `- **Warnings:** ${warning} items completed with warnings\n`;
          if (suspended  !== null && Number(suspended)  > 0) out += `- **Suspended:** ${suspended} items are suspended\n`;

          out += '\n';
          if (Number(total) === 0)
            out += '**Summary:** The source had **no messages** to migrate — the channel or workspace was empty. This is why the ProcessStatus shows NO_MESSAGE.\n';
          else if (Number(processed) === Number(total) && Number(total) > 0)
            out += `**Summary:** Migration is **100% complete** — all ${total} messages have been successfully processed.\n`;
          else if (Number(processed) < Number(total))
            out += `**Summary:** Migration is **incomplete** — ${Number(total) - Number(processed)} out of ${total} messages are still pending.\n`;

          return out;
        }

        // ── CHANNEL INFO ──────────────────────────────────────────────────
        if (/channel|which.*channel|channel.*name|channel.*detail|channel.*info/.test(q)) {
          const channelType = fv('ChannelType','channeltype');
          const channelId   = fv('ChannelId','channelid');
          const isDM        = fv('DirectOrGroupMessage','directorgroupmessage');
          const teamsId     = fv('TeamsId','teamsid');

          if (!channel && !channelType) return null;

          let out = `**Channel Information${idRef}**\n\n`;
          if (channel)     out += `- **Channel Name:** ${channel}\n`;
          if (channelType) {
            out += `- **Channel Type:** ${channelType}`;
            if (channelType === 'im')      out += ' (Direct Message / 1-on-1 conversation)';
            else if (channelType === 'mpim') out += ' (Multi-person Direct Message)';
            else if (channelType === 'channel') out += ' (Public or Private Channel)';
            out += '\n';
          }
          if (isDM !== null) out += `- **Direct or Group Message:** ${isDM === true || isDM === 'true' ? 'Yes — this is a direct/group message conversation' : 'No — this is a channel conversation'}\n`;
          if (channelId)   out += `- **Channel ID:** ${channelId}\n`;
          if (teamsId)     out += `- **Microsoft Teams ID:** ${teamsId}\n`;
          return out;
        }

        return null; // No elaborate handler matched
      }

      let directAnswer = '';
      const elaborated = elaborateAnswer();
      if (elaborated) {
        directAnswer = `${elaborated}\n---\n\n`;
      } else {
        // Fallback: bullet list of relevant fields
        const FALLBACK_MAP = [
          { q: /error|fail|issue|problem/,    f: /error|fail|reason|conflict/i },
          { q: /status|state|progress/,       f: /status|state|progress|phase/i },
          { q: /owner|collaborat|email|mail/, f: /owner|email|mail/i },
          { q: /count|total|many/,            f: /count|total/i },
          { q: /cloud|source|dest/,           f: /cloud|fromcloud|tocloud/i },
          { q: /channel/,                     f: /channel/i },
          { q: /name/,                        f: /name/i },
        ];
        for (const { q: qPat, f: fPat } of FALLBACK_MAP) {
          if (qPat.test(q)) {
            const hits = allFields.filter(f => fPat.test(f)).slice(0, 8);
            if (hits.length > 0) {
              directAnswer = `**Answer:**\n${hits.map(f => `- **${f}**: ${record[f]}`).join('\n')}\n\n---\n\n`;
              break;
            }
          }
        }
      }

      // ── DYNAMIC FIELD GROUPING by field name pattern ─────────────────────
      // Order matters — first matching group wins for each field
      const DYNAMIC_GROUPS = [
        { name: 'Identity & IDs',
          test: f => /^_?id$|uniqueworkspace|^workspace.*id$|^channel.*id$|^job.*id$|^main.*ws|^session.*id|^src.*channel/i.test(f) },
        { name: 'Source Cloud',
          test: f => /^from|^src[^channel]|^source/i.test(f) },
        { name: 'Destination Cloud',
          test: f => /^to[^tal]|^dest|^target/i.test(f) },
        { name: 'Owner & Workspace',
          test: f => /owner|workspacename|^workspacelock|^workspace$/i.test(f) },
        { name: 'Channel Info',
          test: f => /channel|thread|room/i.test(f) },
        { name: 'Users & Emails',
          test: f => /email|mail|userid|emailpair/i.test(f) },
        { name: 'Migration Status',
          test: f => /status|state|progress|phase|halt|lock|checking/i.test(f) },
        { name: 'Message & File Counts',
          test: f => /count|total|processed|inprogress|suspend|pause|warning|retrying/i.test(f) },
        { name: 'Error & Conflict Info',
          test: f => /error|fail|conflict.*reason|exception|issue|warning/i.test(f) },
        { name: 'Timestamps & Dates',
          test: f => /time$|date$|at$|created|modified|updated|timestamp|lastdelta|channeldate/i.test(f) },
        { name: 'Migration Type & Config',
          test: f => /^type$|^class$|combination|jobid|migration|delta|newimpl/i.test(f) },
        { name: 'Folders & URLs',
          test: f => /folder|path|url|drive|weburl/i.test(f) },
      ];

      const assigned = new Set();
      const groups = {};
      DYNAMIC_GROUPS.forEach(g => { groups[g.name] = []; });
      groups['Settings & Flags'] = [];

      for (const field of allFields) {
        let matched = false;
        for (const g of DYNAMIC_GROUPS) {
          if (g.test(field) && !assigned.has(field)) {
            groups[g.name].push(field);
            assigned.add(field);
            matched = true;
            break;
          }
        }
        if (!matched) {
          groups['Settings & Flags'].push(field);
        }
      }

      let groupedText = '';
      const groupOrder = [...DYNAMIC_GROUPS.map(g => g.name), 'Settings & Flags'];

      for (const groupName of groupOrder) {
        const fields = groups[groupName];
        if (!fields || fields.length === 0) continue;

        if (groupName === 'Settings & Flags' && fields.length > 0) {
          // Separate boolean flags from non-boolean values
          const boolTrue  = fields.filter(f => record[f] === true  || record[f] === 'true');
          const boolFalse = fields.filter(f => record[f] === false || record[f] === 'false');
          const others    = fields.filter(f => !boolTrue.includes(f) && !boolFalse.includes(f));
          let chunk = '';
          if (others.length)    chunk += others.map(f => `  - **${f}**: ${record[f]}`).join('\n') + '\n';
          if (boolTrue.length)  chunk += `  - Enabled: ${boolTrue.join(', ')}\n`;
          if (boolFalse.length) chunk += `  - Disabled: ${boolFalse.join(', ')}`;
          groupedText += `**${groupName}**\n${chunk}\n\n`;
        } else {
          const lines = fields.map(f => `  - **${f}**: ${record[f]}`).join('\n');
          groupedText += `**${groupName}**\n${lines}\n\n`;
        }
      }

      // Build a one-line human summary at the top
      const cloudFrom  = record['FromCloudName'] || record['SourceCloud'] || '';
      const cloudTo    = record['ToCloudName']   || record['DestCloud']   || '';
      const wsName     = record['WorkSpaceName'] || record['Name']        || record['name'] || '';
      const procStatus = record['ProcessStatus'] || record['Status']      || record['status'] || '';
      const errDesc    = allFields.find(f => /error/i.test(f)) ? record[allFields.find(f => /error/i.test(f))] : '';

      const summaryParts = [];
      if (wsName)     summaryParts.push(`workspace **"${wsName}"**`);
      if (cloudFrom && cloudTo) summaryParts.push(`migrating from **${cloudFrom}** to **${cloudTo}**`);
      if (procStatus) summaryParts.push(`status is **${procStatus}**`);
      if (errDesc && /\w/.test(String(errDesc))) summaryParts.push(`error: _${errDesc}_`);

      const summaryLine = summaryParts.length > 0
        ? `This record is for ${summaryParts.join(', ')}.\n\n`
        : '';

      const idLabel = specificId ? ` for \`${specificId}\`` : '';
      return `**${subject}** record${idLabel}:\n\n${summaryLine}${directAnswer}${groupedText}`;
    }

    // ── Multi-row: human summary + table ─────────────────────────────────
    const table = mdTable(headers, rows, { maxCols: 8, maxRows: 25, maxCell: 60 });

    // Build natural-language insights from the data
    const insights = [];

    // Status breakdown
    const statusIdx = headers.findIndex(h => /status|state|stage/i.test(h));
    if (statusIdx !== -1) {
      const counts = {};
      rows.forEach(r => { const s = r[statusIdx] || 'Unknown'; counts[s] = (counts[s] || 0) + 1; });
      const top = Object.entries(counts).sort((a,b) => b[1]-a[1]).slice(0, 6);
      insights.push(`**Status breakdown:** ${top.map(([k,v]) => `${k} (${v})`).join(', ')}`);
    }

    // Error description summary
    const errIdx = headers.findIndex(h => /error|reason|fail|conflict.*reason/i.test(h));
    if (errIdx !== -1) {
      const errorVals = [...new Set(rows.map(r => r[errIdx]).filter(v => v && String(v) !== 'null' && String(v) !== 'NULL'))];
      if (errorVals.length > 0) {
        insights.push(`**Unique errors/reasons (${errorVals.length}):** ${errorVals.slice(0, 3).join(' | ')}${errorVals.length > 3 ? ` ... +${errorVals.length-3} more` : ''}`);
      }
    }

    // Source/destination cloud
    const fromIdx = headers.findIndex(h => /fromcloud.*name|from.*cloud.*name/i.test(h));
    const toIdx   = headers.findIndex(h => /tocloud.*name|to.*cloud.*name/i.test(h));
    if (fromIdx !== -1 && toIdx !== -1) {
      const pair = rows[0];
      insights.push(`**Migration route:** ${pair[fromIdx]} → ${pair[toIdx]}`);
    }

    // Owner emails
    const ownerIdx = headers.findIndex(h => /owner.*email|owneremail/i.test(h));
    if (ownerIdx !== -1) {
      const owners = [...new Set(rows.map(r => r[ownerIdx]).filter(Boolean))];
      if (owners.length <= 5) insights.push(`**Owner(s):** ${owners.join(', ')}`);
    }

    const summaryText = insights.length > 0 ? '\n\n' + insights.join('\n') : '';
    const extra = rows.length > 25
      ? `\n\n_Showing first 25 of **${rows.length} total records**. Scroll the results grid below to see all._`
      : '';

    return `I found **${rows.length} records** in the **${subject}** collection:${summaryText}\n\n${table}${extra}`;
  }

  const ai = await client();
  if (!ai) return plainSummary();

  try {
    const tableData = rows.slice(0, 100).map(row =>
      headers.reduce((obj, h, i) => ({ ...obj, [h]: row[i] }), {})
    );
    const queryStr = queryInfo?.isMongo
      ? `MongoDB pipeline on "${queryInfo.collection}": ${queryInfo.query}`
      : `SQL: ${queryInfo?.sql}`;

    const text = await llmChat({
      max_tokens: 1500,
      system: `You are a CloudFuze migration analyst. Answer the user's question directly using the data returned.
- Start with the KEY ANSWER in bold
- If numbers: state them clearly (e.g. "There are **47 users**")
- If multiple rows: show as a markdown table
- Be direct, skip filler phrases`,
      messages: [{
        role: 'user',
        content: `Question: "${question}"\n${queryStr}\nData (${rows.length} rows): ${JSON.stringify(tableData, null, 1)}`
      }]
    });
    return text || plainSummary();
  } catch (e) {
    handleApiError(e, 'interpretResults');
    return plainSummary();
  }
}

export async function suggestQuestions(schema) {
  const mongo = isMongoDB(schema);
  const tableList = (schema?.tables || []).map(t => t.name).slice(0, 20).join(', ');
  // Use static defaults — no LLM call. Suggestions fire on every DB switch, and
  // spending scarce free-tier requests on them would starve real questions.
  return getDefaultSuggestions(tableList, mongo);
}

function getDefaultSuggestions(tableList, isMongo) {
  return [
    'How many users are in the system?',
    'Show the latest activity records',
    'What is the status breakdown?',
    'How many workspaces have been migrated?',
    'Show all channel data',
    'How many messages have been processed?',
    'Show workspace migration progress',
    'What are the most recent errors or failures?',
  ];
}

export async function explainSQL(sql) {
  const ai = await client();
  if (!ai) return 'AI explanation unavailable.';
  try {
    const text = await llmChat({
      max_tokens: 200,
      system: 'Explain this query in 1-2 plain English sentences.',
      messages: [{ role: 'user', content: sql }]
    });
    return text || 'Could not generate explanation.';
  } catch (e) {
    handleApiError(e, 'explainSQL');
    return 'Could not generate explanation.';
  }
}

export async function directAnswer(question, schema, errorContext = '') {
  const tableList = (schema?.tables || []).map(t => t.name);
  const ai = await client();
  const mongo = isMongoDB(schema);

  if (!ai) {
    return `The database has **${tableList.length} ${mongo ? 'collections' : 'tables'}**: ${tableList.slice(0, 8).join(', ')}${tableList.length > 8 ? '...' : ''}.\n\nCould not retrieve data for "${question}". ${errorContext || 'Please reconnect and try again.'}`;
  }

  try {
    const colSample = (schema?.tables || []).slice(0, 8).map(t => {
      const cols = (t.fields || []).slice(0, 4).map(f => f.name).join(', ');
      return `${t.name}(${cols})`;
    }).join('; ');
    const text = await llmChat({
      max_tokens: 400,
      system: `You are a CloudFuze DB analyst. A ${mongo ? 'MongoDB' : 'SQL'} query failed. Describe which collection/field would answer the question and what the user should try.`,
      messages: [{ role: 'user', content: `Q: "${question}"\nSchema: ${colSample}\nError: ${errorContext}` }]
    });
    return text || `Database has ${tableList.slice(0, 6).join(', ')}. Could not retrieve data for "${question}". ${errorContext}`;
  } catch (e) {
    handleApiError(e, 'directAnswer');
    return `Database has ${tableList.slice(0, 6).join(', ')}. Could not retrieve data for "${question}". ${errorContext}`;
  }
}
