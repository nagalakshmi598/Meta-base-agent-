import express from 'express';
import { getClientFromSession } from '../services/metabaseService.js';
import {
  generateSQL, interpretResults, suggestQuestions, explainSQL,
  isAIAvailable, directAnswer, planWithLLM, synthesizeAnswer,
  answerVisionQuestion, answerFromDocs, explainCollectionPurpose, explainAnything
} from '../services/aiService.js';
import { reloadDocs, getDocsCount } from '../services/docsService.js';
import {
  detectAndAnswerGeneral, getTopCollections, buildQueryForTable,
  isSchemaListQuestion, isSchemaNavigationQuestion, answerSchemaNavigation,
  getScanData, enrichTableFields, getCatalog, setCatalog,
  answerCatalogQuestion, getSavedQueries, setSavedQueries,
  answerSavedQueriesQuestion,
  isForecastQuestion, extractSpecificFilter, buildIdMatchCondition,
  buildNameMatchCondition, pickStatusFieldName, findTimeField, parseTimestampMs,
  classifyForecastCounts, computeForecast, humanizeDuration, withPercentages,
  isReasonQuestion, getContentCollections, isContentQuestion, markUserActivity,
  contentFamiliesFor, getReportSnapshot, saveReportSnapshot,
  followUpsBlock, confidenceLine
} from '../services/queryService.js';
import { logQuery, getRecentLogs } from '../services/queryLogService.js';

const router = express.Router();

const requireAuth = (req, res, next) => {
  if (!req.session.metabaseToken) {
    return res.status(401).json({ error: 'Session expired. Please reconnect to Metabase.', reconnect: true });
  }
  next();
};

// Turn a raw Mongo/SQL engine error into a short, human-friendly explanation
function humanizeQueryError(raw) {
  const msg = String(raw || '');
  if (/nonempty array|\$and\/\$or\/\$nor/i.test(msg))            return 'the generated filter came out empty/invalid';
  if (/unknown|unrecognized|no such field|FieldPath|missing/i.test(msg)) return 'the query referenced a field that does not exist in that collection';
  if (/tim(e|ed)\s*out/i.test(msg))                             return 'the database took too long to respond';
  if (/not authorized|unauthorized|permission|forbidden/i.test(msg)) return 'the database rejected the query due to permissions';
  if (/parse|syntax|BadValue|invalid/i.test(msg))               return 'the generated query had a syntax problem';
  return 'the database could not run the generated query';
}

// Run an async fn over items with a bounded concurrency (so we never fire a huge
// burst of heavy MongoDB scans at once). Preserves input order in the result.
async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(Math.max(1, limit), items.length || 1) }, async () => {
    while (next < items.length) { const i = next++; out[i] = await fn(items[i], i); }
  });
  await Promise.all(workers);
  return out;
}

// Answer for ONE specific record found by its _id (e.g. "what is the process
// status of this <ObjectId>"). Leads with the exact status and reason, then
// shows the record's key fields — deterministic, straight from the document.
export function buildSingleDocAnswer(id, collectionName, doc, dbName = '') {
  const keys = Object.keys(doc);
  const statusKey = keys.find(k => /^process_?status$|^status$|^state$/i.test(k))
                 || keys.find(k => /status$/i.test(k)) || keys.find(k => /status|state/i.test(k));
  const status = statusKey ? doc[statusKey] : null;
  const errKey = keys.find(k => /errordescription|error_description|usererror|errormessage|failreason|conflictreason|conflictdescription/i.test(k))
              || keys.find(k => /reason|cause/i.test(k));
  const err = errKey ? doc[errKey] : null;

  const L = [];
  L.push(status
    ? `The status of this record is **${status}**.`
    : `Here is the record \`${id}\`.`);
  L.push('');
  L.push(`_📂 Data source: \`${collectionName}\` collection${dbName ? ` in the \`${dbName}\` database` : ''} — record \`${id}\` (matched by \`_id\`)._`);
  if (err != null && String(err).trim() !== '' && String(err).trim() !== '-') {
    L.push('');
    L.push(`**Reason / error description:** ${String(err).replace(/\|/g, '/')}`);
  }
  L.push('');
  // Key fields (non-empty, not huge), so the user sees the record's detail.
  const entries = keys
    .filter(k => !/^_id$/i.test(k))
    .map(k => [k, doc[k]])
    .filter(([, v]) => v != null && String(v).trim() !== '' && String(v).trim() !== '-' && String(v).length < 200)
    .slice(0, 20);
  if (entries.length) {
    L.push(`| Field | Value |`);
    L.push(`|---|---|`);
    for (const [k, v] of entries) L.push(`| ${k} | ${String(v).replace(/\|/g, '/').replace(/[\r\n]+/g, ' ')} |`);
  }
  return L.join('\n') + followUpsBlock('record') + confidenceLine('high');
}

// Compose a full, human-agent-style MIGRATION REPORT from the computed numbers.
// Everything here is DETERMINISTIC — counts, percentages and dates come from the
// real query + rate math, never invented. Includes: a per-status table with
// percentages, a plain-English summary, the completion ETA, an optional
// files-vs-folders split, and the collection(s) the data came from.
export function buildReportAnswer({ filter, statusRows, buckets, fc, statusField, perCollection, timeField, fileFolder, queryStr, typeScope, dbName, primaryName, prev, nowIso }) {
  const label = filter.type === 'id' ? `workspace \`${filter.value}\``
    : filter.type === 'server' ? `the **${filter.value}** server`
    : `**${filter.value}**`;
  const total = buckets.total || 0;
  const pctOf = n => (total > 0 ? Math.round((n / total) * 1000) / 10 : 0);
  const cols = perCollection || [];
  const L = [];

  L.push(`## Migration report${typeScope ? ` — ${typeScope} only` : ''} — ${label}`);
  if (primaryName) L.push(`_Breakdown from the \`${primaryName}\` collection (grouped by \`${statusField}\`)._`);
  if (typeScope) L.push(`_Counts are for **${typeScope}** only._`);
  L.push('');

  // Combined per-status table with counts + percentages (every real status value).
  L.push(`| Status | Count | % of total |`);
  L.push(`|---|---:|---:|`);
  for (const r of statusRows) {
    L.push(`| ${r.value ?? '(none)'} | ${r.count.toLocaleString('en-US')} | ${r.pct}% |`);
  }
  L.push(`| **Total** | **${total.toLocaleString('en-US')}** | **100%** |`);
  L.push('');

  // Plain-English summary grouped into the buckets the user asked about.
  L.push(`**In summary:**`);
  L.push(`- ✅ **Processed / migrated:** ${buckets.processed.toLocaleString('en-US')} (${pctOf(buckets.processed)}%)`);
  L.push(`- ⏳ **Not processed:** ${buckets.notProcessed.toLocaleString('en-US')} (${pctOf(buckets.notProcessed)}%)`);
  if (buckets.inProgress > 0) L.push(`- 🔄 **In progress:** ${buckets.inProgress.toLocaleString('en-US')} (${pctOf(buckets.inProgress)}%)`);
  if (buckets.conflict > 0)   L.push(`- ⚠️ **Conflict:** ${buckets.conflict.toLocaleString('en-US')} (${pctOf(buckets.conflict)}%)`);
  if (buckets.retry > 0)      L.push(`- 🔁 **Retry:** ${buckets.retry.toLocaleString('en-US')} (${pctOf(buckets.retry)}%)`);
  if (buckets.failed > 0)     L.push(`- ❌ **Failed / error:** ${buckets.failed.toLocaleString('en-US')} (${pctOf(buckets.failed)}%)`);
  if (buckets.paused > 0)     L.push(`- ⏸️ **Paused / suspended:** ${buckets.paused.toLocaleString('en-US')} (${pctOf(buckets.paused)}%)`);
  if (buckets.cancelled > 0)  L.push(`- 🚫 **Cancelled:** ${buckets.cancelled.toLocaleString('en-US')} (${pctOf(buckets.cancelled)}%)`);
  if (buckets.warning > 0)    L.push(`- ⚡ **Warning:** ${buckets.warning.toLocaleString('en-US')} (${pctOf(buckets.warning)}%)`);
  if (buckets.empty > 0)      L.push(`- ⚪ **No message / empty source:** ${buckets.empty.toLocaleString('en-US')} (${pctOf(buckets.empty)}%)`);
  L.push('');

  // PROGRESS SINCE LAST CHECK — show what changed vs the previous time this exact
  // report was asked, so the user sees migration progress over time.
  if (prev && prev.buckets && nowIso && prev.at) {
    const agoMs = Date.parse(nowIso) - Date.parse(prev.at);
    const ago = agoMs > 0 ? humanizeDuration(agoMs) : 'a moment';
    const delta = (cur, was) => {
      const d = (cur || 0) - (was || 0);
      if (d > 0) return `**+${d.toLocaleString('en-US')}**`;
      if (d < 0) return `**${d.toLocaleString('en-US')}**`;
      return 'no change';
    };
    const pb = prev.buckets;
    const rows = [
      ['✅ Processed', buckets.processed, pb.processed],
      ['⏳ Not processed', buckets.notProcessed, pb.notProcessed],
      ['🔄 In progress', buckets.inProgress, pb.inProgress],
      ['⚠️ Conflict', buckets.conflict, pb.conflict],
    ].filter(([, cur, was]) => (cur || 0) !== (was || 0) || true);
    const changedProcessed = (buckets.processed || 0) - (pb.processed || 0);
    L.push(`**📈 Progress since your last check (${ago} ago):**`);
    for (const [labelTxt, cur, was] of rows) L.push(`- ${labelTxt}: ${delta(cur, was)} (now ${(cur || 0).toLocaleString('en-US')})`);
    if (changedProcessed > 0) L.push(`_➡️ **${changedProcessed.toLocaleString('en-US')}** more items were migrated since last time._`);
    else if (changedProcessed === 0) L.push(`_➡️ No new items migrated since last time._`);
    L.push('');
  }

  // Files vs folders split — shown for an UN-scoped report. When the split
  // covers fewer items than the grand total (because only some collections carry
  // a file/folder flag), we say so, so the two totals never look contradictory.
  if (!typeScope && fileFolder) {
    const files = fileFolder.files || 0, folders = fileFolder.folders || 0, sum = files + folders;
    if (sum > 0) {
      const note = (total > 0 && sum < total)
        ? ` _(of ${sum.toLocaleString('en-US')} items that carry a file/folder flag; other collections don't split by type)_`
        : '';
      L.push(`**By type:** 📄 Files: **${files.toLocaleString('en-US')}** · 📁 Folders: **${folders.toLocaleString('en-US')}**${note}`);
      L.push('');
    }
  }

  // Per-collection breakdown so every collection's contribution is visible.
  if (cols.length > 1) {
    L.push(`**By collection** (where this workspace's data lives):`);
    L.push(`| Collection | Items | Processed | Not processed | Conflict |`);
    L.push(`|---|---:|---:|---:|---:|`);
    for (const c of cols) {
      L.push(`| ${c.name} | ${c.buckets.total.toLocaleString('en-US')} | ${c.buckets.processed.toLocaleString('en-US')} | ${c.buckets.notProcessed.toLocaleString('en-US')} | ${c.buckets.conflict.toLocaleString('en-US')} |`);
    }
    L.push('');
  }

  // Completion estimate.
  if (fc.done) {
    L.push(`🎉 **Everything is processed** — there's nothing left in the queue, so this workspace is effectively **completed**.`);
  } else if (fc.ok) {
    const perDay = Math.max(1, Math.round(fc.perDay));
    const eta = humanizeDuration(fc.etaMs);
    const whenStr = new Date(fc.completionMs).toISOString().slice(0, 10);
    L.push(`**Estimated completion:** at the current rate of ~**${perDay.toLocaleString('en-US')} items/day**${timeField ? ` (from the \`${timeField}\` timeline)` : ''}, the remaining **${buckets.remaining.toLocaleString('en-US')}** should finish in **${eta}**, around **${whenStr}** — when the workspace should reach **completed**. ✅`);
    L.push(`> ⓘ Estimate assumes a steady rate; if items are stuck it may take longer. It sharpens as more items complete.`);
  } else {
    L.push(`**Estimated completion:** I can't project a reliable date yet because ${fc.reason}.`);
  }
  L.push('');

  // Provenance + the exact query, so the user can verify / re-run in Metabase.
  L.push(`_📂 Data source:${dbName ? ` \`${dbName}\` database →` : ''} ${cols.map(c => `\`${c.name}\``).join(', ')} — grouped by \`${statusField}\`._`);
  if (queryStr) {
    L.push('');
    L.push('**MongoDB query used** (run per collection):');
    L.push('```json');
    L.push(queryStr);
    L.push('```');
  }
  return L.join('\n') + followUpsBlock('report') + confidenceLine('high');
}

router.get('/config', (req, res) => {
  const aiEnabled = isAIAvailable();
  res.json({
    ai_enabled: aiEnabled,
    mode: aiEnabled ? 'ai' : 'sql',
    message: aiEnabled ? 'AI mode active' : 'Keyword mode — questions matched to collections automatically',
    docs_indexed: getDocsCount()
  });
});

router.post('/query', requireAuth, async (req, res) => {
  const { question, sql: directSQL, database_id, schema, history = [], images = [] } = req.body;

  if (!database_id) return res.status(400).json({ error: 'Please select a database first' });

  let mbClient, token;
  try {
    ({ client: mbClient, token } = getClientFromSession(req.session));
  } catch {
    return res.status(401).json({ error: 'Session expired. Please reconnect.', reconnect: true });
  }

  // ── AUDIT LOG: record every response this endpoint returns (who / what / query) ──
  const _t0 = Date.now();
  const _json = res.json.bind(res);
  res.json = (payload = {}) => {
    try {
      logQuery({
        user: req.session.metabaseEmail || req.session.id,
        database_id,
        question: (question || '').trim() || (Array.isArray(images) && images.length ? '[image/screenshot]' : ''),
        mode: payload.mode,
        query_type: payload.query_type || (directSQL ? 'direct_sql' : undefined),
        collection: payload.collection || (payload.tables_used && payload.tables_used[0]) || null,
        query: payload.sql || null,
        row_count: payload.results?.row_count ?? null,
        execution_ms: payload.execution_time_ms ?? (Date.now() - _t0),
        status: (payload.error || payload.query_type === 'error') ? 'error' : 'ok'
      });
    } catch {}
    // Remember the collection(s) this answer came from, so a follow-up like
    // "which collection is that from?" can be answered from ground truth instead
    // of the LLM guessing. Only update on real data answers (don't clobber with
    // meta/error responses that carry no collection).
    try {
      const colls = (payload.tables_used && payload.tables_used.length)
        ? payload.tables_used
        : (payload.collection ? [payload.collection] : null);
      if (colls && colls.length) req.session.lastCollections = colls;
    } catch {}
    return _json(payload);
  };

  // ── DIRECT SQL/MONGO MODE ─────────────────────────────────────────────
  if (directSQL) {
    try {
      const result = await mbClient.post(token, '/api/dataset', {
        type: 'native',
        native: { query: directSQL.trim(), template_tags: {} },
        database: parseInt(database_id, 10)
      });
      if (result.error) return res.status(422).json({ error: result.error, sql: directSQL });
      const rowCount = result.data?.rows?.length || 0;
      return res.json({
        sql: directSQL, explanation: 'Direct query', tables_used: [], query_type: 'sql',
        results: { cols: result.data?.cols || [], rows: result.data?.rows || [], row_count: rowCount },
        answer: `Query returned **${rowCount} row${rowCount !== 1 ? 's' : ''}**.`,
        execution_time_ms: result.running_time, mode: 'sql'
      });
    } catch (err) {
      return res.status(422).json({ error: err.response?.data?.error || err.message, sql: directSQL });
    }
  }

  // ── AI / KEYWORD MODE ─────────────────────────────────────────────────
  const hasImages = Array.isArray(images) && images.length > 0;
  if (!question?.trim() && !hasImages) return res.status(400).json({ error: 'Question is required' });
  if (!schema) return res.status(400).json({ error: 'Schema not loaded. Select a database first.' });

  console.log(`\n[Query] "${question}"${hasImages ? ` [+${images.length} image(s)]` : ''} | db=${database_id}`);

  const isMongo      = (schema.engine || '').toLowerCase().includes('mongo');
  const dbId         = parseInt(database_id, 10);
  const scanCacheKey = `db:${database_id}`; // session-independent + persisted → shared across sessions
  const scanData     = getScanData(scanCacheKey);

  // Only questions that are ABOUT databases/servers or saved queries need those
  // metadata calls. For a normal data question we DON'T block the answer on them —
  // the catalog is learned in the background so future catalog questions are fast.
  const qLower = (question || '').toLowerCase();
  const catalogRelevant = /\b(databases?|servers?)\b/.test(qLower);
  const savedRelevant = /\bsaved\b|(what|which|list|show|how many)[^?]*\b(quer(y|ies)|questions?|cards?|reports?|dashboards?)\b/.test(qLower);

  const buildCatalog = async () => {
    try {
      const dbsResp = await mbClient.get(token, '/api/database', { include: 'tables' });
      const dbList  = Array.isArray(dbsResp) ? dbsResp : dbsResp.data || [];
      const c = dbList.filter(d => !d.is_sample).map(d => ({
        id: d.id, name: d.name, engine: d.engine, collections: (d.tables || []).map(t => t.name)
      }));
      setCatalog(req.session.id, c);
      return c;
    } catch (e) { console.warn('[Catalog] build failed:', e.message); return []; }
  };

  let catalog = getCatalog(req.session.id);
  if (!catalog.length) {
    if (catalogRelevant) catalog = await buildCatalog();       // needed to answer → wait
    else buildCatalog().catch(() => {});                        // background → don't delay
  }

  // Saved Metabase questions — only fetched when the question is about them.
  let savedQueries = getSavedQueries(req.session.id);
  if (!savedQueries.length && savedRelevant) {
    try {
      const cardsResp = await mbClient.get(token, '/api/card', { f: 'all' });
      const cards = Array.isArray(cardsResp) ? cardsResp : cardsResp.data || [];
      const dbName = id => (catalog.find(d => d.id === id)?.name) || '';
      savedQueries = cards.filter(c => c && !c.archived).slice(0, 300).map(c => ({
        id: c.id, name: c.name, description: c.description || '',
        databaseId: c.database_id || c.dataset_query?.database,
        dbName: dbName(c.database_id || c.dataset_query?.database),
        collection: c.dataset_query?.native?.collection || '',
        native: (c.dataset_query?.native?.query || '').slice(0, 500)
      }));
      setSavedQueries(req.session.id, savedQueries);
    } catch (e) { console.warn('[SavedQueries] fetch failed:', e.message); }
  }

  // "What databases are available?" / "which server has X?" → answer from catalog
  const catalogAnswer = answerCatalogQuestion(req.session.id, question);
  if (catalogAnswer) {
    return res.json({ answer: catalogAnswer, mode: 'ai', query_type: 'catalog' });
  }

  // "What saved queries/questions exist?" → answer from the cards cache
  const savedAnswer = answerSavedQueriesQuestion(req.session.id, question);
  if (savedAnswer) {
    return res.json({ answer: savedAnswer, mode: 'ai', query_type: 'saved_queries' });
  }

  // "Which collection is THAT result/aggregate from?" — a follow-up about the
  // PREVIOUS answer. Answer from the collection(s) actually used last turn (kept
  // in the session), never let the LLM guess. Distinct from "which collection has
  // X data" (schema navigation), which references data, not "this/that/the result".
  {
    const ql = (question || '').toLowerCase();
    const asksWhichColl = /(which|what|from which)\s+(collection|table)\b|came? from|generated from|based on which/.test(ql);
    const aboutPrev = /\b(this|that|it|these|those|above|previous|last|the (aggregate|result|report|breakdown|count|answer|data|number|status|query))\b|aggregate|result/.test(ql);
    const lastColls = req.session.lastCollections || [];
    if (lastColls.length && asksWhichColl && aboutPrev) {
      const list = lastColls.map(c => `\`${c}\``).join(', ');
      const noun = lastColls.length > 1 ? 'collections' : 'collection';
      return res.json({
        answer: `That result came from the ${noun} ${list} in the **${schema.name}** database.`,
        mode: 'ai', query_type: 'meta', tables_used: lastColls, collection: lastColls[0]
      });
    }
  }

  // EXPLAIN questions — "what is / what does X mean / explain / describe / purpose
  // of…" for a collection, a field, a status value, or a migration feature. These
  // are answered from the REAL structure (scanned fields, sample values, status
  // vocabulary) + documentation via the LLM — never a stale template, never a
  // "not in docs" dead-end. Excludes actual data queries.
  if (isAIAvailable()) {
    const ql = question.toLowerCase();
    const explainIntent = /\b(what (is|are|does|do)|what.?s|use of|used for|purpose|meaning|explain|describe|tell me about|role of|function of|difference between|how (does|do) .*(work|migrat|handle))\b/i.test(ql);
    // Don't hijack real data queries (counts, status-of-<id>, reports, ETAs…).
    const notData = !/how many|how much|\bcount\b|\blist \b|show me all|breakdown|status of|when will|percentage|group by|which (collection|table)|migrated for|processed for|conflict(s)? for|in ?progress for|for this (wsid|workspace|user|id)|\b[0-9a-f]{16,}\b/i.test(ql);
    if (explainIntent && notData) {
      try {
        // A collection was explicitly named → explain it from its real structure.
        if (/\b(collection|table)\b/i.test(ql)) {
          const top = getTopCollections(question, schema, 1, scanData)[0];
          if (top) {
            const answer = await explainCollectionPurpose(top.name, schema, scanData);
            if (answer) return res.json({ answer, mode: 'ai', query_type: 'schema_explain', collection: top.name, tables_used: [top.name] });
          }
        }
        // Otherwise explain the field / status / feature from docs + live schema.
        const answer = await explainAnything(question, schema, scanData);
        if (answer) return res.json({ answer, mode: 'ai', query_type: 'explain' });
      } catch (e) { console.warn('[Explain] failed:', e.message); }
    }
  }

  // ═══ VISION: an image/screenshot was attached → analyze it with the LLM ═══
  if (hasImages) {
    if (!isAIAvailable()) {
      return res.json({
        answer: 'To analyze screenshots I need the AI mode active (a working Gemini/OpenAI key). Right now the assistant is in keyword mode, so I can only answer text questions about the data.',
        mode: 'ai', query_type: 'vision'
      });
    }
    try {
      const answer = await answerVisionQuestion(question, images, schema, scanData);
      if (answer) return res.json({ answer, mode: 'ai', query_type: 'vision' });
      return res.json({ answer: 'I could not analyze the attached image. Please try again, or describe what you need in text.', mode: 'ai', query_type: 'vision' });
    } catch (e) {
      console.warn('[Vision] failed:', e.message);
      return res.json({ answer: 'Something went wrong analyzing the image. Please try again.', mode: 'ai', query_type: 'vision' });
    }
  }

  // Run one native query against Metabase. Returns a normalized result and
  // retries once on a transient MongoDB "server selection" timeout.
  const runNativeSafe = async (queryStr, collection, opts = {}) => {
    markUserActivity(); // tell the background scan to back off — user query in flight
    const body = {
      type: 'native',
      native: isMongo ? { query: queryStr, collection, template_tags: {} } : { query: queryStr, template_tags: {} },
      database: dbId
    };
    // `opts.timeoutMs` hard-caps EACH attempt (so one huge unindexed scan can't
    // hang the request). `opts.retries` overrides the default 3 attempts.
    const MAX = opts.retries ?? 3;
    const timeoutMs = opts.timeoutMs;
    const doPost = () => {
      const call = mbClient.post(token, '/api/dataset', body);
      if (!timeoutMs) return call;
      call.catch(() => {}); // if the timeout wins the race, swallow the later rejection
      return Promise.race([call, new Promise((_, rej) => setTimeout(() => rej(new Error('client-timeout')), timeoutMs))]);
    };
    for (let attempt = 0; attempt < MAX; attempt++) {
      try {
        markUserActivity();
        const r = await doPost();
        if (r?.error) {
          const msg = String(r.error);
          if (/tim(e|ed)\s*out|server that matches|UNKNOWN/i.test(msg) && attempt < MAX - 1) {
            await new Promise(res => setTimeout(res, 1500 * (attempt + 1))); continue; // backoff + retry
          }
          return { ok: false, error: msg, timedOut: /tim(e|ed)\s*out|server that matches/i.test(msg) };
        }
        return { ok: true, data: r.data, running_time: r.running_time };
      } catch (e) {
        const msg = String(e.response?.data?.via?.[0]?.error || e.response?.data?.error || e.message || e);
        const timedOut = /tim(e|ed)\s*out|server that matches|ECONNABORTED|UNKNOWN/i.test(msg);
        if (timedOut && attempt < MAX - 1) { await new Promise(res => setTimeout(res, 1500 * (attempt + 1))); continue; }
        return { ok: false, error: msg, timedOut };
      }
    }
    return { ok: false, error: 'Query failed after retry', timedOut: true };
  };

  // ═══ MIGRATION REPORT — full status breakdown + %, ETA, files/folders, query ═══
  // For a question about a SPECIFIC workspace/user/id that asks about migration
  // status, counts, percentages, conflict/retry, or "when will it finish", give a
  // complete report: every real status with count + %, a files-vs-folders split,
  // an estimated completion date, the collection(s) involved, AND the exact
  // MongoDB query used. Deterministic — counts/dates come from live queries, never
  // invented. Falls through to the normal agent if it can't resolve a workspace.
  // A "why did it conflict / give the error description / reason" question is NOT
  // a status report — it wants the actual reasons. Let the agent's why-handling
  // read the ErrorDescription field instead of producing a counts report.
  const isWhyReason = isReasonQuestion(question);
  const wantsReport = isForecastQuestion(question)
    || /\b(report|percentage|percent|%|breakdown|summary|overall|status|how much|how many|migrat|processed|not[ _]?process|conflict|retry|retries|in[ _]?progress|remaining|pending|completed?)\b/i.test(question);
  if (isMongo && wantsReport && !isWhyReason) {
    let filter = extractSpecificFilter(question);
    // Follow-up like "when will the remaining migrate?" — the workspace id was
    // named earlier in the conversation, not in this message. Carry it forward
    // from the most recent turn that mentioned one, so the ETA/report still runs.
    if (!filter && Array.isArray(history) && history.length) {
      for (const h of [...history].reverse()) {
        const f = extractSpecificFilter(String(h?.content || ''));
        if (f && ['id', 'workspace_name', 'user_name', 'email'].includes(f.type)) { filter = f; break; }
      }
    }
    // Content-migration questions ("how much data migrated…") aggregate the
    // authoritative CONTENT collections (FileFolderInfo, FolderMetadataInfo,
    // CollabarationDetails, HyperLinks, DriveChangeIdDetails). These can run
    // server-wide (no id) — the whole server's content — or filtered to a
    // workspace/user id.
    const isContentQ = isContentQuestion(question);
    const contentColls = getContentCollections(schema, question); // scoped to the family asked (mails→email only)
    const serverWide = !filter && isContentQ && contentColls.length > 0;
    if ((filter && ['id', 'workspace_name', 'user_name', 'email'].includes(filter.type)) || serverWide) {
      try {
        const ql = question.toLowerCase();

        // Is this an AGGREGATE question ("how much / how many processed, conflict,
        // in-progress", a breakdown, percentages, or several statuses at once)?
        // If so we must NOT collapse to a single record — the id is being used as
        // a FOREIGN KEY (e.g. UserId) across many migration records, so we group.
        const statusMentions = (ql.match(/process(ed)?|conflict|progress|migrat|pending|suspend|not[ _]?process|complet|remaining|transferr|version/gi) || []).length;
        const wantsAggregate = /\bhow much\b|\bhow many\b|breakdown|aggregate|distribution|percentage|percent|%|\btotal\b|\ball\b|\beach\b|counts?\b|group|summary|report/i.test(ql)
          || statusMentions >= 2;

        // ── SINGLE RECORD BY _id ────────────────────────────────────────────
        // If the id is a specific document's _id (a 24-hex ObjectId) AND the user
        // wants that ONE record (not an aggregate), answer that record's exact
        // status — e.g. "what is the process status of this <messageId>". Skipped
        // for aggregate asks so a user/workspace id isn't mistaken for a profile.
        if (filter && filter.type === 'id' && /^[0-9a-f]{24}$/i.test(filter.value) && !wantsAggregate) {
          const idCands = getTopCollections(question, schema, 12, scanData).map(t => enrichTableFields(t, scanData));
          const hits = await mapLimit(idCands, 6, async (cand) => {
            const r = await runNativeSafe(JSON.stringify([{ '$match': { _id: { '$oid': filter.value } } }, { '$limit': 1 }]), cand.name, { timeoutMs: 12000, retries: 1 });
            return (r.ok && r.data?.rows?.length) ? { name: cand.name, data: r.data } : null;
          });
          const hit = hits.filter(Boolean)[0];
          if (hit) {
            const cols = (hit.data.cols || []).map(c => c.name);
            const row = hit.data.rows[0];
            const doc = {}; cols.forEach((c, i) => { doc[c] = row[i]; });
            console.log(`[Record] _id ${filter.value} found in ${hit.name}`);
            return res.json({
              answer: buildSingleDocAnswer(filter.value, hit.name, doc, schema.name),
              mode: 'ai', query_type: 'record', is_mongo: true, collection: hit.name, tables_used: [hit.name],
              sql: JSON.stringify([{ '$match': { _id: { '$oid': filter.value } } }], null, 2),
              results: { cols: hit.data.cols || [], rows: hit.data.rows || [], row_count: hit.data.rows?.length || 0 }
            });
          }
          // Not an _id anywhere → it's a workspace/foreign id; fall through to the
          // aggregated report below.
        }

        // Scope to ONE type only when the user names that type ALONE. "files and
        // folders" (both) or neither → a COMBINED report (with a by-type split),
        // never "folders only" just because the word "folders" appears.
        const mentionsFiles = /\bfiles?\b/i.test(ql);
        const mentionsFolders = /\bfolders?\b/i.test(ql);
        const wantsFolders = mentionsFolders && !mentionsFiles;
        const wantsFiles = mentionsFiles && !mentionsFolders;
        const typeScope = wantsFolders ? 'folders' : wantsFiles ? 'files' : null;
        // A workspace's data spans many collections (files, folders, collabs,
        // conflicts…). We read every one that holds this workspace's data — but
        // with BOUNDED CONCURRENCY and a TIME BUDGET so a burst of heavy unindexed
        // scans can't time the request out.
        const REPORT_BUDGET_MS = 75000;
        const reportStart = Date.now();
        const timeLeft = () => REPORT_BUDGET_MS - (Date.now() - reportStart);
        // Candidates: for a CONTENT question use the authoritative content
        // collections (FileFolderInfo first); otherwise the top-scored ones.
        const fcCands = ((isContentQ && contentColls.length)
          ? contentColls
          : getTopCollections(`${question} status migrated processed in progress conflict files folders collaboration`, schema, 8, scanData)
        ).map(t => enrichTableFields(t, scanData));
        // Pass 1 — probe each candidate with the SAME simple $match + $group the
        // user validated, at most 4 at a time. Keep every collection with data.
        const probed = await mapLimit(fcCands, 4, async (cand) => {
          if (timeLeft() < 10000) return null; // stop starting new scans near the deadline
          const flds = cand.fields || [];
          const statusField = pickStatusFieldName(flds.map(f => f.name));
          if (!statusField) return null;
          // No filter (server-wide) → match the whole collection; else by id/name.
          const idMatch = !filter ? {}
            : (filter.type === 'id'
              ? buildIdMatchCondition(flds, filter.value, question)
              : buildNameMatchCondition(flds, filter.type, filter.value));
          const hasId = idMatch && Object.keys(idMatch).length > 0;
          const folderF = flds.find(f => /^folder$/i.test(f.name));
          const typeFilter = folderF ? (wantsFolders ? { [folderF.name]: true } : wantsFiles ? { [folderF.name]: false } : null) : null;
          const matchStage = typeFilter ? (hasId ? { '$and': [idMatch, typeFilter] } : typeFilter) : (hasId ? idMatch : null);
          // Build the query in Metabase's idiomatic style ($group with an object
          // _id, then $sort + $project to flatten) so what we display matches
          // exactly what Metabase runs — users can copy it and validate directly.
          const groupStages = [
            { '$group': { '_id': { [statusField]: `$${statusField}` }, 'count': { '$sum': 1 } } },
            { '$sort': { '_id': 1 } },
            { '$project': { '_id': false, [statusField]: `$_id.${statusField}`, 'count': true } },
          ];
          const pipeline = matchStage ? [{ '$match': matchStage }, ...groupStages] : groupStages;
          // Hard 30s cap per collection so one huge unindexed scan can't hang the
          // whole report — a collection that exceeds it is simply skipped.
          const r = await runNativeSafe(JSON.stringify(pipeline), cand.name, { timeoutMs: 30000, retries: 1 });
          if (!r.ok || !(r.data?.rows?.length)) return null;
          // Parse by COLUMN NAME (order-independent): the status column and `count`.
          const cnames = (r.data.cols || []).map(c => c.name);
          const countIdx = cnames.findIndex(n => /^count$/i.test(n));
          const statusIdx = cnames.findIndex((n, idx) => idx !== countIdx);
          const statusValues = r.data.rows.map(row => ({
            value: row[statusIdx >= 0 ? statusIdx : 0],
            count: Number(row[countIdx >= 0 ? countIdx : row.length - 1]) || 0,
          }));
          const total = statusValues.reduce((a, s) => a + s.count, 0);
          return total > 0 ? {
            name: cand.name, statusField, statusValues, total, idMatch, matchStage,
            folderF: folderF?.name || null, timeFieldName: findTimeField(flds)?.name || null,
            queryStr: JSON.stringify(pipeline, null, 2),
          } : null;
        });
        let withData = probed.filter(Boolean).sort((a, b) => b.total - a.total);
        // Keep only MIGRATION collections: their status values must look like
        // migration statuses (PROCESSED/CONFLICT/IN_PROGRESS/…), not a profile flag
        // like true/false. This stops a Users/profile doc (matched by _id) from
        // polluting a migration breakdown for a foreign-key id (e.g. UserId).
        const looksMigration = sv => (sv || []).some(s =>
          /process|conflict|progress|migrat|complet|pending|suspend|fail|queue|not[ _]?process|transferr|moved|\bdone\b|version|no[_ ]?message|resume|skip|success|error|retry/i.test(String(s.value)));
        const migrationOnly = withData.filter(c => looksMigration(c.statusValues));
        if (migrationOnly.length) withData = migrationOnly;   // drop non-migration noise
        // Order so the AUTHORITATIVE collection is first: prefer a `processStatus`
        // field (the standard migration status the user validates in Metabase),
        // then the richest by matches. withData[0] becomes the single collection
        // whose breakdown we report (no cross-collection merge / mixed statuses).
        withData.sort((a, b) => {
          const ap = /^process_?status$/i.test(a.statusField) ? 1 : 0;
          const bp = /^process_?status$/i.test(b.statusField) ? 1 : 0;
          return bp - ap || b.total - a.total;
        });
        if (withData.length) {
          // Pass 2 — timeline (for the ETA) + files/folders split, but only for the
          // few BIGGEST collections (they drive the rate and the type split), and
          // only while there's time budget left. Bounded concurrency.
          const enrichTargets = withData.slice(0, 4).filter(() => timeLeft() > 12000);
          await mapLimit(enrichTargets, 3, async (c) => {
            const jobs = [];
            if (c.timeFieldName) {
              jobs.push(runNativeSafe(JSON.stringify([{ '$match': c.idMatch }, { '$group': { '_id': null, 'first': { '$min': `$${c.timeFieldName}` }, 'last': { '$max': `$${c.timeFieldName}` } } }]), c.name, { timeoutMs: 20000, retries: 1 }).then(tr => {
                if (tr.ok && tr.data?.rows?.length) {
                  const cols = (tr.data.cols || []).map(x => x.name);
                  const row = tr.data.rows[0];
                  const fi = cols.indexOf('first'), li = cols.indexOf('last');
                  c.firstMs = parseTimestampMs(fi >= 0 ? row[fi] : null);
                  c.lastMs = parseTimestampMs(li >= 0 ? row[li] : null);
                }
              }).catch(() => {}));
            }
            if (c.folderF && !typeScope) {
              jobs.push(runNativeSafe(JSON.stringify([{ '$match': c.idMatch }, { '$group': { '_id': `$${c.folderF}`, 'count': { '$sum': 1 } } }]), c.name, { timeoutMs: 20000, retries: 1 }).then(fr => {
                if (fr.ok && fr.data?.rows?.length) {
                  c.hasFolder = true; c.files = 0; c.folders = 0;
                  for (const row of fr.data.rows) {
                    const isFolder = row[0] === true || String(row[0]).toLowerCase() === 'true';
                    if (isFolder) c.folders += Number(row[row.length - 1]) || 0; else c.files += Number(row[row.length - 1]) || 0;
                  }
                }
              }).catch(() => {}));
            }
            await Promise.all(jobs);
          });
          const pick = withData[0];
          const statusValues = pick.statusValues;
          const buckets = classifyForecastCounts(statusValues);
          const statusRows = withPercentages(statusValues);
          const primaryQueryStr = pick.queryStr;

          // Timeline + files/folders come from the SAME authoritative collection.
          const firstMs = pick.firstMs ?? null, lastMs = pick.lastMs ?? null;
          const timeField = pick.timeFieldName || null;
          let fileFolder = null;
          if (!typeScope && pick.hasFolder) fileFolder = { files: pick.files || 0, folders: pick.folders || 0 };

          const fc = computeForecast({ processed: buckets.processed, remaining: buckets.remaining, firstMs, lastMs, nowMs: Date.now() });
          // Other collections that also have this workspace's data — listed for
          // transparency (NOT merged into the breakdown above).
          const perCollection = withData.map(c => ({ name: c.name, total: c.total, buckets: classifyForecastCounts(c.statusValues) }));

          // PROGRESS DELTA: remember this report's numbers keyed by
          // database + target (workspace/user id or "server") + family, so
          // re-asking the same question shows what changed since last time.
          const famKey = isContentQ ? contentFamiliesFor(question).sort().join(',') : 'report';
          const snapKey = `${database_id}::${(filter && filter.value) || 'server'}::${typeScope || famKey}`;
          const prevSnap = getReportSnapshot(snapKey);
          const nowIso = new Date().toISOString();

          const answer = buildReportAnswer({
            filter: filter || { type: 'server', value: schema.name }, statusRows, buckets, fc, statusField: pick.statusField,
            perCollection, timeField, fileFolder, queryStr: primaryQueryStr, typeScope, dbName: schema.name,
            primaryName: pick.name, prev: prevSnap, nowIso
          });
          saveReportSnapshot(snapKey, { buckets, total: buckets.total }, nowIso);
          console.log(`[Report] primary=${pick.name} (${withData.length} with data): total=${buckets.total} processed=${buckets.processed} conflict=${buckets.conflict} eta_ok=${fc.ok}`);
          return res.json({
            answer, mode: 'ai', query_type: 'report',
            sql: primaryQueryStr, is_mongo: true, collection: pick.name,
            tables_used: withData.map(c => c.name),
            // The query behind the breakdown shown (Metabase-style) so users can
            // copy it and validate; other collections with data are listed in the
            // answer's "By collection" section.
            queries: [{ collection: pick.name, query: primaryQueryStr }],
            results: { cols: [{ name: pick.statusField }, { name: 'count' }], rows: [...statusValues].sort((a, b) => b.count - a.count).map(s => [s.value, s.count]), row_count: statusValues.length }
          });
        }
      } catch (e) {
        console.warn('[Report] failed, falling back to agent:', e.message);
      }
    }
  }

  // ═══ SUPER AGENT (LLM + intents) — primary path when an LLM is available ═══
  if (isAIAvailable()) {
    try {
      const plan = await planWithLLM(question, schema, scanData, history, catalog, savedQueries);
      if (plan?.sub_questions?.length) {
        console.log(`[Agent] ${plan.sub_questions.length} sub-question(s): ${plan.sub_questions.map(s => s.intent).join(', ')}`);
        const parts = [];
        let primaryResult = null, primaryQuery = null, primaryCollection = null;

        for (const sq of plan.sub_questions) {
          let intent = sq.intent || 'data_query';
          // Guard: if the LLM mislabeled a real DATA question as "list databases"
          // or "list collections", treat it as a data_query so we answer from the
          // selected database instead of dumping the server/collection list.
          if ((intent === 'list_databases' || intent === 'schema_list')
              && /\bmigrat|process|conflict|status|how much|how many|\brecord|\bfiles?\b|\bfolders?\b|messages?|\busers?\b|workspace|count|breakdown|percentage|\berror|reason|when will|\bwsid\b|[0-9a-f]{16,}/i.test(`${sq.text || ''} ${question}`)) {
            intent = 'data_query';
          }

          if (intent === 'data_query') {
            // DETERMINISTIC collection + query: the keyword scorer picks the right
            // collection more reliably than the lite LLM. Score with BOTH the
            // sub-question and full question so the entity stays in scope; pick the
            // OPERATION (count/breakdown/list/filter) from the sub-question alone.
            const scopeText  = `${sq.text || ''} ${question}`.trim();
            const opText     = sq.text || question;
            // A specific lookup (id / email / quoted name) → search ACROSS candidate
            // collections until one has the record (e.g. an in-progress workspace
            // lives in MessageWorkSpace, not ConflictMessageWorkSpace).
            const isSpecific = /\b[0-9a-f]{16,}\b|[\w.+-]+@[\w-]+\.\w+|["'][^"']{2,}["']/i.test(scopeText);
            // Classify the operation FIRST — it decides how many collections to
            // search.
            const opLower = (sq.operation || '').toLowerCase();
            const isWhyQ = opLower === 'why' || isReasonQuestion(opText);
            // A MIGRATION-VOLUME question ("how much migrated / processed / not
            // processed / progress / conflict count …"). For these the real data
            // lives in a per-ITEM detail collection (FileFolderInfo, MessageEachFiles),
            // NOT the small summary table — so we scan the top handful and keep the
            // collection with the RICHEST result (most items, or most real reasons).
            //   NOTE: this is deliberately NOT plain "how many <entity>" counting —
            //   "how many workspaces" must stay on the entity table (top-scored),
            //   never jump to a bigger per-message collection.
            const isVolumeQ = isWhyQ
              || /how much|migrat|process|progress|conflict|pending|transferr?ed|uploaded|synced|not[ _]?done|remaining/i.test(opText);

            // Candidate breadth:
            //   • specific lookup (id/email/quoted name) → search the TOP-RANKED
            //     collections only (not all 140). The scorer + real scan data rank
            //     the collection that holds the record near the top whenever the
            //     question names an entity ("messages", "wsid", "user"…), so a
            //     capped, parallel search finds it in ~1–2s instead of scanning
            //     every collection (which made it hang on "Thinking…").
            //   • migration-volume / why → the top handful, then pick the RICHEST
            //     result — so it isn't pinned to a single mis-ranked side-table;
            //   • plain count / list / lookup → the single top collection (the
            //     scorer is reliable when there's a clear entity).
            const specificCap = Math.min((schema.tables || []).length, 24);
            const candCount = isSpecific ? specificCap : (isVolumeQ ? 6 : 1);
            const cands = getTopCollections(scopeText, schema, candCount, scanData)
              .map(t => enrichTableFields(t, scanData));
            const scoreOf = (res) => {
              const rows = res?.data?.rows || [];
              if (isWhyQ) { // distinct real error reasons
                let n = 0;
                for (const row of rows) { const v = row[0]; if (typeof v === 'string' && v.trim().length > 4 && !/^\d+$/.test(v.trim())) n++; }
                return n;
              }
              // volume: sum the numeric count column (grouped result), else row count
              let sum = 0;
              for (const row of rows) { const last = row[row.length - 1]; sum += (typeof last === 'number' ? last : 1); }
              return sum;
            };
            const EXIT = isWhyQ ? 3 : 100; // "rich enough" → stop searching

            let result = null, queryStr = null, collection = null;
            let firstResult = null, firstQuery = null, firstColl = null;
            let best = null, bestQuery = null, bestColl = null, bestScore = 0;
            // LLM-classified operation hint → phrasing-robust query building.
            const hints = { operation: sq.operation, filterValue: sq.filter_value };
            const BATCH = isSpecific ? 12 : (isVolumeQ ? 6 : 1);
            // Wall-clock budget so the search NEVER hangs. Once exceeded we stop
            // and use the best/first result found so far → a fast, honest answer.
            const searchStart = Date.now();
            const SEARCH_BUDGET_MS = 18000;
            for (let i = 0; i < cands.length && !result; i += BATCH) {
              if (Date.now() - searchStart > SEARCH_BUDGET_MS) {
                console.log(`[Agent] search budget reached (${i}/${cands.length} scanned) — using best so far`);
                break;
              }
              const settled = await Promise.all(
                cands.slice(i, i + BATCH).map(cand => {
                  const built = buildQueryForTable(opText, cand, schema.engine, hints);
                  if (!built) return Promise.resolve(null);
                  const qStr = built.query || built.sql;
                  const coll = built.collection || cand.name;
                  return runNativeSafe(qStr, coll).then(r => ({ r, qStr, coll }));
                })
              );
              const valid = settled.filter(Boolean);
              for (const s of valid) {
                if (!firstResult) { firstResult = s.r; firstQuery = s.qStr; firstColl = s.coll; }
                if (!(s.r.ok && (s.r.data?.rows?.length || 0) > 0)) continue;
                if (isVolumeQ) {
                  // Migration-volume/why: keep the collection with the richest
                  // result (most real reasons, or most total items) — whether the
                  // question is specific to one workspace or a generic "how much
                  // migrated". Plain entity counts skip this and take top-scored.
                  const sc = scoreOf(s.r);
                  if (sc > bestScore) { best = s.r; bestQuery = s.qStr; bestColl = s.coll; bestScore = sc; }
                  if (sc >= EXIT) { result = s.r; queryStr = s.qStr; collection = s.coll; break; } // rich enough
                } else {
                  result = s.r; queryStr = s.qStr; collection = s.coll; break; // first with rows
                }
              }
              if (!result && valid.length && valid.every(s => s.r.timedOut)) { result = firstResult; queryStr = firstQuery; collection = firstColl; break; }
            }
            // aggregate question: use the collection with the richest result found
            if (!result && best) { result = best; queryStr = bestQuery; collection = bestColl; }
            // Nothing had rows → try the LLM's own query as a last resort
            if (!result && sq.query) {
              const r = await runNativeSafe(sq.query, sq.collection);
              if (r.ok && (r.data?.rows?.length || 0) > 0) { result = r; queryStr = sq.query; collection = sq.collection; }
            }
            if (!result) { result = firstResult; queryStr = firstQuery; collection = firstColl; }
            if (!result) { parts.push({ text: sq.text, intent, collection, staticAnswer: null }); continue; }

            if (result.ok) {
              const rows    = result.data?.rows || [];
              const headers = (result.data?.cols || []).map(c => c.display_name || c.name);
              parts.push({ text: sq.text, intent, collection, rows, headers, query: queryStr });
              if (!primaryResult || rows.length > 0) {
                primaryResult = { data: result.data, running_time: result.running_time };
                primaryQuery = queryStr; primaryCollection = collection;
              }
            } else if (result.timedOut) {
              parts.push({ text: sq.text, intent, collection, query: queryStr,
                staticAnswer: `⏳ The database (MongoDB) was momentarily unreachable and the query for this part **timed out**. This is a temporary connection issue with the Metabase → MongoDB server, not your question. Please try again in a few seconds.` });
            } else {
              parts.push({ text: sq.text, intent, collection, query: queryStr,
                staticAnswer: `I couldn't find **${(sq.text || question).slice(0, 80)}** in the workspace collections I searched (${cands.map(c => c.name).slice(0, 4).join(', ')}). It may not exist, or may be in a different database.` });
            }

          } else if (intent === 'schema_explain') {
            parts.push({ text: sq.text, intent, staticAnswer: answerSchemaNavigation(sq.text || question, schema) });

          } else if (intent === 'schema_list') {
            const listLines = (schema.tables || []).map(t => `- **${t.name}** (${(t.fields || []).length} fields)`).join('\n');
            parts.push({ text: sq.text, intent, staticAnswer: `This database has **${(schema.tables || []).length} collections**:\n\n${listLines}` });

          } else if (intent === 'list_databases') {
            const dbLines = catalog.map(d => `- **${d.name}** (${(d.collections || []).length} collections)`).join('\n');
            parts.push({ text: sq.text, intent, staticAnswer: `You have **${catalog.length} databases (servers)** connected:\n\n${dbLines}` });

          } else if (intent === 'cross_database') {
            const target = sq.database || 'another database';
            parts.push({ text: sq.text, intent, staticAnswer: `That data lives in the **${target}** database, not the one currently selected (**${schema.name}**). Switch to **${target}** from the sidebar's database dropdown, then ask again — I'll query it there.` });

          } else { // documentation / general_knowledge → RAG over the docs, then fall back
            let docsAns = null;
            try { docsAns = await answerFromDocs(sq.text || question); } catch {}
            parts.push({ text: sq.text, intent, staticAnswer: docsAns || detectAndAnswerGeneral(sq.text || question, schema) || '' });
          }
        }

        const answer = await synthesizeAnswer(question, parts, history, schema.name);

        return res.json({
          sql: primaryQuery || undefined,
          explanation: plan.sub_questions.map(s => s.note).filter(Boolean).join(' '),
          tables_used: [...new Set(parts.map(p => p.collection).filter(Boolean))],
          query_type: 'agent',
          is_mongo: isMongo,
          collection: isMongo ? primaryCollection : undefined,
          results: primaryResult ? {
            cols: primaryResult.data?.cols || [],
            rows: primaryResult.data?.rows || [],
            row_count: primaryResult.data?.rows?.length || 0
          } : undefined,
          answer: answer || 'I could not generate an answer. Please try rephrasing.',
          execution_time_ms: primaryResult?.running_time,
          mode: 'ai'
        });
      }
      console.log('[Agent] No plan produced — falling back to rule-based routing');
    } catch (e) {
      console.warn('[Agent] failed, using rule-based fallback:', e.message);
    }
  }

  // ═══ RULE-BASED FALLBACK (no LLM available, or the agent produced nothing) ═══

  // Phase 0-A: "What collections exist?" — answer from schema directly
  if (isSchemaListQuestion(question)) {
    const tables = schema.tables || [];
    const noun = isMongo ? 'collection' : 'table';
    const listLines = tables.map(t => {
      const fCount = (t.fields || []).length;
      return `- **${t.name}** (${fCount} ${fCount === 1 ? 'field' : 'fields'})`;
    }).join('\n');
    return res.json({
      answer: `This database has **${tables.length} ${noun}s**:\n\n${listLines}`,
      mode: 'ai'
    });
  }

  // Phase 0-B: "In which collection is users data?" — schema navigation + live data
  if (isSchemaNavigationQuestion(question)) {
    console.log('[Query] Schema navigation — finding collection + executing query');

    const navCandidates = getTopCollections(question, schema, 3, scanData);
    let navQuery = null, navResult = null;

    for (const table of navCandidates) {
      const q = buildQueryForTable(question, table, schema.engine);
      if (!q) continue;
      const nq = isMongo
        ? { query: q.query, collection: q.collection, template_tags: {} }
        : { query: q.sql, template_tags: {} };
      try {
        const result = await mbClient.post(token, '/api/dataset', { type: 'native', native: nq, database: dbId });
        if (!result.error && (result.data?.rows?.length ?? 0) > 0) {
          navQuery  = q;
          navResult = result;
          break;
        }
      } catch (e) {
        console.warn(`[Query] Nav "${table.name}" error: ${e.message}`);
      }
    }

    // If we got live data, return it with schema context
    if (navResult && navQuery) {
      const collectionName = navQuery.collection || navQuery.tables_used?.[0] || '';
      let answer;
      try { answer = await interpretResults(question, navQuery, navResult); }
      catch { answer = `Found **${navResult.data?.rows?.length || 0} records**.`; }

      return res.json({
        sql: isMongo ? navQuery.query : navQuery.sql,
        explanation: navQuery.explanation,
        tables_used: navQuery.tables_used || [],
        query_type: navQuery.query_type || 'list',
        is_mongo: isMongo,
        collection: isMongo ? navQuery.collection : undefined,
        results: {
          cols: navResult.data?.cols || [],
          rows: navResult.data?.rows || [],
          row_count: navResult.data?.rows?.length || 0
        },
        answer: `The **${collectionName}** collection is where you can find this data. Here's what it contains:\n\n${answer}`,
        execution_time_ms: navResult.running_time,
        mode: 'ai'
      });
    }

    // No live data — fall back to schema description only
    const navAnswer = answerSchemaNavigation(question, schema);
    return res.json({ answer: navAnswer, mode: 'ai' });
  }

  // Phase 0-C: General knowledge question — answer without querying the DB
  const knowledgeAnswer = detectAndAnswerGeneral(question, schema);
  if (knowledgeAnswer) {
    console.log('[Query] Answered as general knowledge question');
    return res.json({ answer: knowledgeAnswer, mode: 'ai' });
  }

  // Phase 1: Try top scored collections in order until we get results
  const candidates = getTopCollections(question, schema, 8, scanData);
  console.log(`[Query] Top candidates: ${candidates.map(t => t.name).join(', ')} (scan cache: ${scanData.size} collections)`);

  let queryResult_obj    = null;
  let execResult         = null;
  let lastError          = '';
  let lastAttemptedQuery = '';
  let lastAttemptedColl  = '';

  for (const rawTable of candidates) {
    const table = enrichTableFields(rawTable, scanData); // backfill fields from scan
    const q = buildQueryForTable(question, table, schema.engine);
    if (!q) continue;
    lastAttemptedQuery = isMongo ? q.query : q.sql;
    lastAttemptedColl  = q.collection || table.name;

    const nativeQuery = isMongo
      ? { query: q.query, collection: q.collection, template_tags: {} }
      : { query: q.sql, template_tags: {} };

    console.log(`[Query] Trying "${table.name}": ${(isMongo ? q.query : q.sql)?.substring(0, 100)}`);

    try {
      const result = await mbClient.post(token, '/api/dataset', {
        type: 'native', native: nativeQuery, database: dbId
      });

      if (result.error) {
        lastError = result.error;
        console.warn(`[Query] "${table.name}" → Metabase error: ${result.error}`);
        continue;
      }

      const rowCount = result.data?.rows?.length ?? 0;
      console.log(`[Query] "${table.name}" → ${rowCount} rows`);

      // Accept this result (even 0 rows) if first candidate, otherwise only if has rows
      if (!queryResult_obj || rowCount > 0) {
        queryResult_obj = q;
        execResult      = result;
        if (rowCount > 0) break; // Found data — stop searching
      }
    } catch (err) {
      lastError = err.response?.data?.error || err.message;
      console.warn(`[Query] "${table.name}" → exec error: ${lastError}`);
    }
  }

  // If nothing worked at all, fall back to AI-generated query via generateSQL
  if (!execResult) {
    try {
      queryResult_obj = await generateSQL(question, schema, history);
      lastAttemptedQuery = isMongo ? queryResult_obj.query : queryResult_obj.sql;
      lastAttemptedColl  = queryResult_obj.collection || lastAttemptedColl;
      const nq = isMongo
        ? { query: queryResult_obj.query, collection: queryResult_obj.collection, template_tags: {} }
        : { query: queryResult_obj.sql, template_tags: {} };
      execResult = await mbClient.post(token, '/api/dataset', { type: 'native', native: nq, database: dbId });
    } catch (e) {
      // Clean, human answer + show the query we attempted (no raw error dump)
      return res.json({
        answer: `I wasn't able to pull data for **"${question}"** — ${humanizeQueryError(lastError || e.message)}.\n\nThe MongoDB query I attempted is shown below so you can see exactly what ran. Try rephrasing, or ask about a specific collection.`,
        sql: lastAttemptedQuery || undefined,
        is_mongo: isMongo,
        collection: isMongo ? lastAttemptedColl : undefined,
        query_type: 'error',
        mode: 'ai'
      });
    }
  }

  if (execResult?.error) {
    const attempted = (isMongo ? queryResult_obj?.query : queryResult_obj?.sql) || lastAttemptedQuery;
    return res.json({
      answer: `I couldn't retrieve results for **"${question}"** from **${queryResult_obj?.collection || lastAttemptedColl || 'the database'}** — ${humanizeQueryError(execResult.error)}.\n\nHere is the MongoDB query I attempted so you can see exactly what ran. Try rephrasing your question, or ask me to explain the collection first.`,
      sql: attempted || undefined,
      is_mongo: isMongo,
      collection: isMongo ? (queryResult_obj?.collection || lastAttemptedColl) : undefined,
      explanation: queryResult_obj?.explanation,
      tables_used: queryResult_obj?.tables_used || [],
      query_type: 'error',
      mode: 'ai'
    });
  }

  const displayQuery = isMongo ? queryResult_obj.query : queryResult_obj.sql;

  // Phase 2: Interpret results → English answer with actual data
  let answer;
  try {
    answer = await interpretResults(question, queryResult_obj, execResult);
  } catch {
    const rowCount = execResult.data?.rows?.length || 0;
    answer = rowCount === 0
      ? `No data found in **${queryResult_obj.collection || queryResult_obj.tables_used?.[0]}** for your question. Try selecting a different database or rephrasing.`
      : `Found **${rowCount} records** in **${queryResult_obj.collection || queryResult_obj.tables_used?.[0]}**.`;
  }

  return res.json({
    sql: displayQuery,
    explanation: queryResult_obj.explanation,
    tables_used: queryResult_obj.tables_used || [],
    query_type: queryResult_obj.query_type || 'list',
    is_mongo: isMongo,
    collection: isMongo ? queryResult_obj.collection : undefined,
    results: {
      cols: execResult.data?.cols || [],
      rows: execResult.data?.rows || [],
      row_count: execResult.data?.rows?.length || 0
    },
    answer,
    execution_time_ms: execResult.running_time,
    mode: 'ai'
  });
});

router.post('/suggest', requireAuth, async (req, res) => {
  const { schema } = req.body;
  if (!schema) return res.status(400).json({ error: 'Schema required' });
  try {
    const suggestions = await suggestQuestions(schema);
    res.json({ suggestions });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/explain', requireAuth, async (req, res) => {
  const { sql } = req.body;
  if (!sql) return res.status(400).json({ error: 'SQL required' });
  try {
    const explanation = await explainSQL(sql);
    res.json({ explanation });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Audit trail — every query the agent has run (most recent first).
// e.g. GET /api/ai/query-log?limit=100
router.get('/query-log', requireAuth, (req, res) => {
  const limit = Math.min(parseInt(req.query.limit, 10) || 100, 1000);
  res.json({ logs: getRecentLogs(limit) });
});

// Re-index the docs/ folder after adding or editing documentation (RAG source).
router.post('/reload-docs', requireAuth, (req, res) => {
  const chunks = reloadDocs();
  res.json({ reloaded: true, chunks });
});

export default router;
