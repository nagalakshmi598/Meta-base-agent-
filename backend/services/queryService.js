export function isMongoDB(schema) {
  const engine = (schema?.engine || '').toLowerCase();
  return engine.includes('mongo');
}

// The AUTHORITATIVE collections that hold CONTENT migration data. "How much data
// migrated" must aggregate across THESE — not the biggest collection or a guess.
// (Files live in FileFolderInfo; folders in FolderMetadataInfo; plus
// collaboration, hyperlinks, and drive-change records.)
export const CONTENT_COLLECTION_PATTERNS = [
  /^filefolderinfo$/i,
  /^foldermetadata?info$/i,
  /^collab.?rationdetails$/i,   // CollabarationDetails (their spelling) or CollaborationDetails
  /hyperlink/i,
  /^drivechange.?id.?details$/i,
];

// Return the content-migration collections that actually exist in this schema,
// in a sensible order (FileFolderInfo first).
export function getContentCollections(schema) {
  const tables = schema?.tables || [];
  const out = [];
  for (const pat of CONTENT_COLLECTION_PATTERNS) {
    for (const t of tables) {
      if (pat.test(t.name) && !out.includes(t)) out.push(t);
    }
  }
  return out;
}

// Is the question about CONTENT / "how much data" migration (files, folders,
// collaborations, hyperlinks) rather than a specific entity count?
export function isContentQuestion(question) {
  const q = (question || '').toLowerCase();
  return /\bhow much data\b|\bdata migrated\b|migrated (so far|till now|already|in this server)|\bcontent\b|files? and folders|entire (data|migration|content)|whole (data|migration)|overall (data|migration|status)|total (data|migration)|all (the )?(data|content)|across (the )?server|in this server\b/i.test(q)
      || /how much.*(migrat|process|data)/i.test(q);
}

// Pick the single field that best represents a collection's migration/status
// state, from a plain list of column names. Used by the deep scan (to know which
// field to GROUP for the real status vocabulary) and by the query builder. Most
// specific names first (processStatus/transferStatus/…), then any "…status",
// then a looser state/progress/stage match.
export function pickStatusFieldName(cols = []) {
  const names = (cols || []).map(c => (typeof c === 'string' ? c : c?.name)).filter(Boolean);
  return (
    names.find(n => /^(process_?status|migration_?status|transfer_?status|job_?status|move_?status|sync_?status|status|state)$/i.test(n)) ||
    names.find(n => /status$/i.test(n)) ||
    names.find(n => /status|state|progress|stage/i.test(n)) ||
    null
  );
}

// ── CANONICAL STATUS CLASSIFIER ────────────────────────────────────────────
// CloudFuze has NO single status enum — every scheduler/entity defines its own
// (CFMoveWorkSpace, CFMove_EachFile, CFMessageEachFiles, MultiUserMoveQueue,
// MessageJob, transfer-status, permission, metadata, links, prescan…). They
// share a vocabulary though, so we map any real value to ONE canonical bucket.
// Ordered so combined/negated values resolve correctly (NOT_/YET_ before
// processed; PROCESSING/IN_PROGRESS before processed; PROCESSED_WITH_SOME_* →
// processed). Buckets: processed | inProgress | notProcessed | conflict |
// failed | retry | paused | cancelled | warning | empty | other.
const STATUS_RE = {
  notProcessed: /not[ _]?process|unprocess|not[ _]?migrat|not[ _]?complet|not[ _]?done|not[ _]?start|notstarted|yet[ _]?to|yet_to|pending|queued|in[ _]?queue|picking[_ ]?not|premigration|pre[_ ]?scan|report_notprocessed|\btodo\b|to[ _]?do|waiting|invite[_ ]?member/,
  inProgress:   /in[ _]?progress|inprogress|processing|picking[_ ]?in|delta[_ ]?in|\brunning\b|ongoing|migrating|transferring|\bmoving\b|\bstarted\b|\bresume\b|restart|space_not_closed/,
  processed:    /processed|process_with|complete|completed|success|migrated|transferr?ed|\bmoved\b|copied|uploaded|synced|finished|\bdone\b|partially[_ ]?complet|multiusertrail|report[_ ]?download|cloud[_ ]?deleted|picking[_ ]?done/,
  conflict:     /conflict/,
  failed:       /\bfail\b|failed|failure|\berror\b|exception|rejected|\babort/,
  retry:        /retry|retries|retrying|reattempt|requeue/,
  paused:       /\bpause\b|paused|suspend|\bstop\b|trial[_ ]?pause/,
  cancelled:    /cancel/,
  timedOut:     /timed?[ _]?out/,
  warning:      /warning|\bwarn\b/,
  empty:        /no[_ ]?message|no[_ ]?report|not[_ ]?required/,
};

// Map a single status value → its canonical bucket (precedence-ordered).
export function classifyStatusValue(value) {
  const v = String(value == null ? '' : value).toLowerCase();
  if (!v) return 'other';
  if (STATUS_RE.notProcessed.test(v)) return 'notProcessed';
  if (STATUS_RE.inProgress.test(v))   return 'inProgress';
  if (STATUS_RE.retry.test(v))        return 'retry';
  if (STATUS_RE.processed.test(v))    return 'processed';   // incl. PROCESSED_WITH_SOME_CONFLICTS
  if (STATUS_RE.conflict.test(v))     return 'conflict';
  if (STATUS_RE.timedOut.test(v))     return 'failed';
  if (STATUS_RE.failed.test(v))       return 'failed';
  if (STATUS_RE.cancelled.test(v))    return 'cancelled';
  if (STATUS_RE.paused.test(v))       return 'paused';
  if (STATUS_RE.warning.test(v))      return 'warning';
  if (STATUS_RE.empty.test(v))        return 'empty';
  return 'other';
}

// Given a collection's REAL status vocabulary ([{value,count}]) and the status
// the user asked about, return the EXACT stored values that match — so we filter
// on ground-truth values. `intent` is one of the canonical buckets plus the
// aliases 'not_processed' | 'in_progress' | 'active' | 'inactive'.
export function matchStatusValues(statusValues, intent) {
  if (!Array.isArray(statusValues) || !statusValues.length || !intent) return [];
  const has = (v, re) => re.test(String(v).toLowerCase());
  // Non-migration flags (account/cloud active/inactive) keep their own matcher.
  if (intent === 'inactive') return statusValues.filter(sv => has(sv.value, /inactive|disabled|suspend|deactivat/)).map(sv => sv.value);
  if (intent === 'active')   return statusValues.filter(sv => has(sv.value, /\bactive\b|enabled/) && !has(sv.value, /inactive|deactivat/)).map(sv => sv.value);
  const bucket = { not_processed: 'notProcessed', in_progress: 'inProgress' }[intent] || intent;
  return statusValues.filter(sv => classifyStatusValue(sv.value) === bucket).map(sv => sv.value);
}

// Turn the free-text question + optional LLM filterValue into a canonical status
// intent used by matchStatusValues(). Ordered so negated/progress phrasings win
// before "processed". Returns '' when no specific status was requested.
export function statusIntent(question, filterValue = '') {
  const s = `${filterValue} ${question}`.toLowerCase();
  if (/\bnot[ _]?process|unprocess|pending|not[ _]?migrat|did\s?n.?t migrat|not[ _]?complet|not[ _]?done|not[ _]?start|yet to|left to|queued|in[ _]?queue|waiting/i.test(s)) return 'not_processed';
  if (/in[ _]?progress|inprogress|processing|still (running|going|migrating|processing)|currently (migrating|processing|running)|ongoing/i.test(s)) return 'in_progress';
  if (/retry|retrying|retries|reattempt/i.test(s)) return 'retry';
  if (/conflict/i.test(s)) return 'conflict';
  if (/fail|error|broken|exception|timed?[ _]?out|abort/i.test(s)) return 'failed';
  if (/process|migrat|complet|success|\bdone\b|finished|transferr?ed|moved|uploaded|synced/i.test(s)) return 'processed';
  if (/suspend|pause/i.test(s)) return 'paused';
  if (/cancel/i.test(s)) return 'cancelled';
  if (/inactive|disabled/i.test(s)) return 'inactive';
  if (/\bactive\b|enabled/i.test(s)) return 'active';
  return '';
}

// ── SMART COLLECTION SCORING ───────────────────────────────────────────────

export const SEMANTIC_CATEGORIES = [
  { keys: ['user', 'member', 'agent', 'people', 'account', 'directory', 'person', 'staff'],
    qKeys: ['user', 'member', 'people', 'person', 'account', 'who', 'staff', 'employee', 'agent'] },
  { keys: ['workspace', 'workspac', 'team', 'org', 'organization', 'company', 'tenant'],
    qKeys: ['workspace', 'team', 'org', 'organization', 'company', 'tenant'] },
  { keys: ['message', 'msg', 'chat', 'conversation', 'post', 'thread'],
    qKeys: ['message', 'msg', 'chat', 'conversation', 'post', 'text', 'reply', 'thread'] },
  { keys: ['channel', 'room', 'group', 'chann'],
    qKeys: ['channel', 'room', 'group', 'channel'] },
  { keys: ['migration', 'migrat', 'transfer', 'sync', 'job', 'task'],
    qKeys: ['migration', 'migrate', 'transfer', 'sync', 'job', 'task'] },
  { keys: ['activity', 'activ', 'log', 'event', 'audit', 'history', 'track'],
    qKeys: ['activity', 'log', 'event', 'audit', 'history', 'recent', 'latest', 'last'] },
  { keys: ['credential', 'cred', 'auth', 'token', 'key', 'oauth', 'secret'],
    qKeys: ['credential', 'auth', 'token', 'key', 'api', 'password', 'oauth', 'secret'] },
  { keys: ['file', 'attachment', 'document', 'doc', 'asset', 'upload'],
    qKeys: ['file', 'attachment', 'document', 'doc', 'upload', 'download'] },
  { keys: ['status', 'state', 'progress', 'stage', 'result'],
    qKeys: ['status', 'state', 'progress', 'stage', 'result', 'breakdown', 'summary'] },
  { keys: ['folder', 'directory', 'drive', 'storage'],
    qKeys: ['folder', 'directory', 'drive', 'storage', 'path'] },
  { keys: ['error', 'fail', 'exception', 'issue'],
    qKeys: ['error', 'fail', 'failure', 'broken', 'issue', 'problem', 'exception'] },
  { keys: ['conflict', 'Conflict'],
    qKeys: ['conflict', 'conflicted', 'why', 'reason', 'cause'] },
  { keys: ['apikey', 'api_key', 'ApiKey'],
    qKeys: ['api key', 'apikey', 'api_key'] },
];

export function scoreTable(tableName, question) {
  const name = tableName.toLowerCase();
  const q = question.toLowerCase();
  let score = 0;

  // Highest priority: collection name appears verbatim in question
  if (q.includes(name)) score += 120;

  // Word-level direct matches
  const nameWords = name.split(/[_\-\s.]+/).filter(w => w.length > 2);
  const qWords = q.replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter(w => w.length > 2);
  for (const nw of nameWords) {
    for (const qw of qWords) {
      if (nw === qw) score += 35;
      else if (nw.length > 3 && (nw.startsWith(qw) || qw.startsWith(nw))) score += 18;
      else if (nw.length > 4 && qw.length > 4 && nw.includes(qw)) score += 10;
    }
  }

  // Semantic category matching. The ENTITY (workspace/user/message/…) selects
  // the collection; "status/state/progress" is an OPERATION on that entity's
  // collection (a field), NOT a reason to pick a *Status side-table.
  for (const cat of SEMANTIC_CATEGORIES) {
    const nameMatch = cat.keys.some(k => name.includes(k));
    const qMatch    = cat.qKeys.some(k => q.includes(k));
    if (!nameMatch || !qMatch) continue;
    const isOperationCat = cat.keys.includes('status') || cat.keys.includes('state');
    score += isOperationCat ? 8 : 40;
    // PRIMARY-TABLE bonus: the collection name ENDS with the matched entity
    // (e.g. "MessageWorkSpace" ends with "workspace") → it's the main entity
    // table, not a suffixed side-table like "MessageWorkSpaceTransferStatus".
    if (!isOperationCat && cat.keys.some(k => name.endsWith(k))) score += 45;
  }

  // Penalize DERIVED / SECONDARY tables (status snapshots, stats, queues, logs,
  // retries, backoffs…) so the MAIN entity collection wins. e.g. a question about
  // "workspaces" should hit MessageWorkSpace, not MessageWorkSpaceTransferStatus.
  if (/transferstatus|transferstats|movecount|aggregation|\bstats\b|statsinfo|counter|\bqueue\b|retry|backoff|_bkp|backup|\bhistory\b|auditlog/i.test(name)) {
    score -= 55;
  }

  return score;
}

// ── SCAN CACHE: actual sample data from all collections ───────────────────
// key = "sessionId:dbId" → Map<collectionName, {cols: string[], sampleValues: {field: string[]}}>
const scanCache = new Map();

export function setScanData(cacheKey, collectionName, data) {
  if (!scanCache.has(cacheKey)) scanCache.set(cacheKey, new Map());
  scanCache.get(cacheKey).set(collectionName, data);
}

export function getScanData(cacheKey) {
  return scanCache.get(cacheKey) || new Map();
}

export function getScanStatus(cacheKey) {
  const cache = scanCache.get(cacheKey);
  if (!cache) return { scanned: 0, ready: false };
  return { scanned: cache.size, ready: cache.size > 0 };
}

// ── GLOBAL CATALOG: every database (server) and its collections ────────────
// key = sessionId → [{ id, name, engine, collections: [names] }]
// Lets the agent know what lives on which server, so it can route the user to
// the right database even when it's not the one currently selected.
const catalogCache = new Map();

export function setCatalog(sessionId, catalog) {
  catalogCache.set(sessionId, catalog || []);
}
export function getCatalog(sessionId) {
  return catalogCache.get(sessionId) || [];
}

// Progress of a background "deep-learn all servers" scan, per session.
const scanProgress = new Map();
export function setScanProgress(sessionId, p) { scanProgress.set(sessionId, p); }
export function getScanProgress(sessionId) { return scanProgress.get(sessionId) || { status: 'idle' }; }

// Guess what a database is used for from its name (message / content / email).
export function classifyDatabase(name) {
  const n = (name || '').toLowerCase();
  if (/mail|email|outlook|gmail|exchange/.test(n)) return 'Email migration';
  if (/msg|message|chat|slack|teams|conversation/.test(n)) return 'Message migration';
  if (/content|file|drive|folder|doc|sharepoint|box|dropbox/.test(n)) return 'Content / file migration';
  return 'Migration data';
}

// ── SAVED QUERIES: Metabase Questions/Cards (pre-built queries) ────────────
// key = sessionId → [{ id, name, description, databaseId, dbName, collection, native }]
const savedQueriesCache = new Map();

export function setSavedQueries(sessionId, cards) { savedQueriesCache.set(sessionId, cards || []); }
export function getSavedQueries(sessionId) { return savedQueriesCache.get(sessionId) || []; }

// Answer "what saved queries/questions/reports exist" from the cards cache.
export function answerSavedQueriesQuestion(sessionId, question) {
  const q = (question || '').toLowerCase();
  const cards = getSavedQueries(sessionId);
  if (!cards.length) return null;
  const asks = /(what|which|list|show|any|how many).*(saved\s+)?(quer(y|ies)|questions?|cards?|reports?|dashboards?)\b/.test(q)
            || /\b(saved|existing|available)\s+(quer|question|report|card)/.test(q);
  if (!asks) return null;
  const byDb = {};
  for (const c of cards) { (byDb[c.dbName || 'Other'] ||= []).push(c); }
  const blocks = Object.entries(byDb).slice(0, 12).map(([db, list]) => {
    const items = list.slice(0, 15).map(c => `  - **${c.name}**${c.description ? ` — ${c.description.slice(0, 90)}` : ''}`).join('\n');
    return `**${db}** (${list.length}):\n${items}`;
  });
  return `There are **${cards.length} saved queries/questions** in Metabase:\n\n${blocks.join('\n\n')}\n\nAsk me about any of these and I'll run a live query for the answer.`;
}

// Which database holds a collection/keyword? Returns matching {db, collections}.
export function findInCatalog(sessionId, keyword) {
  const catalog = getCatalog(sessionId);
  const k = (keyword || '').toLowerCase();
  const hits = [];
  for (const db of catalog) {
    const matched = (db.collections || []).filter(c => c.toLowerCase().includes(k));
    if (matched.length) hits.push({ database: db.name, purpose: classifyDatabase(db.name), collections: matched });
  }
  return hits;
}

// Answer "what databases/servers are available" and "which server has X" from
// the catalog (no DB query needed). Returns null if the question isn't about that.
export function answerCatalogQuestion(sessionId, question) {
  const q = (question || '').toLowerCase();
  const catalog = getCatalog(sessionId);
  if (!catalog.length) return null;

  // "which database/server has <X>" — check the SPECIFIC lookup first
  const m = q.match(/which (?:database|server|db)\s+(?:has|contains|holds|stores|for|is)\s+(.+)/);
  if (m) {
    const term = m[1].replace(/[?.!]/g, '').replace(/\b(data|collection|stored|the|a|an|in|located)\b/g, '').trim().split(/\s+/)[0] || '';
    const hits = term ? findInCatalog(sessionId, term) : [];
    if (hits.length) {
      const lines = hits.map(h => `- **${h.database}** (_${h.purpose}_): ${h.collections.slice(0, 8).join(', ')}`).join('\n');
      return `Here's where **"${term}"** appears across your servers:\n\n${lines}\n\nSwitch to that database in the sidebar to query it.`;
    }
    return `I couldn't find a collection matching **"${term}"** in any database. Ask "what databases are available" to see them all.`;
  }

  // Only answer "list the databases/servers" when the question is ACTUALLY about
  // that — not any data question that merely mentions the word "database". Exclude
  // anything with data intent (migrated/processed/status/count/files/…), so those
  // are answered from the selected database instead of listing all servers.
  const dataIntent = /migrat|process|conflict|status|record|\bfiles?\b|\bfolders?\b|messages?|\busers?\b|workspace|how much data|\bcollection|count of|breakdown|percentage|\berror|reason|when will|in[ _]?progress|pending|suspend/i.test(q);
  const asksList = !dataIntent && (
       /\b(list|show|what|which|how many)\b[^?]{0,25}\b(databases?|servers?)\b/.test(q)
    || /\b(databases?|servers?)\b[^?]{0,20}(available|there|exist|connected|do (i|we) have|are (there|connected))/.test(q)
    || /available\s+(databases?|servers?)/.test(q)
  );
  if (asksList) {
    const lines = catalog.map(db => {
      const n = (db.collections || []).length;
      return `- **${db.name}** — _${classifyDatabase(db.name)}_ (${n} collection${n !== 1 ? 's' : ''})`;
    }).join('\n');
    return `You have **${catalog.length} databases (servers)** connected in Metabase:\n\n${lines}\n\nSelect any one from the sidebar to explore its collections and ask questions about its data.`;
  }
  return null;
}

// Score a collection based on its actual sample values matching the question
function scoreSampleData(question, sampleData) {
  if (!sampleData) return 0;
  const q = question.toLowerCase();
  const qWords = q.replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter(w => w.length > 3);
  if (!qWords.length) return 0;

  let score = 0;
  const { sampleValues = {} } = sampleData;

  for (const [fieldName, values] of Object.entries(sampleValues)) {
    const fn = fieldName.toLowerCase();
    // Field name matches a question word → strong signal
    for (const qw of qWords) {
      if (fn === qw) score += 20;
      else if (fn.includes(qw) || qw.includes(fn)) score += 8;
    }
    // A sample value contains a question keyword → moderate signal
    for (const val of (values || []).slice(0, 5)) {
      const v = String(val).toLowerCase();
      for (const qw of qWords) {
        if (v.includes(qw)) score += 4;
      }
    }
  }

  // GROUND-TRUTH STATUS MATCH: if the user asked about a specific status
  // (processed / conflict / not migrated / failed / …) and this collection's REAL
  // status vocabulary (captured during the deep scan) actually contains a value
  // for that status, strongly prefer it — the answer lives where the status
  // genuinely exists, not in a name-alike side-table that lacks those rows.
  const intent = statusIntent(question);
  if (intent && Array.isArray(sampleData.statusValues) && sampleData.statusValues.length) {
    const hits = matchStatusValues(sampleData.statusValues, intent);
    if (hits.length) {
      const matched = sampleData.statusValues.filter(sv => hits.includes(sv.value));
      const rows = matched.reduce((a, sv) => a + (sv.count || 0), 0);
      score += 30;                       // this collection really has that status
      if (rows >= 100) score += 15;      // …with meaningful volume
    }
  }

  return Math.min(score, 110); // cap per-collection boost
}

// Return the top-N scored tables from the schema, boosted by real sample data
export function getTopCollections(question, schema, n = 5, scanData = new Map()) {
  const tables = schema?.tables || [];
  return tables
    .map(t => {
      let score = scoreTable(t.name, question);
      if (scanData && scanData.has(t.name)) {
        const sd = scanData.get(t.name);
        // Collection was scanned successfully → it actually CONTAINS data.
        // Prefer it over empty name-matching side-tables (e.g. ConflictFile*).
        score += 22;
        score += scoreSampleData(question, sd);
        // Data-volume signal. Prefer the TRUE document count (read during the
        // scan) — a graded boost so a 96,000-doc main entity table decisively
        // outranks a 6-doc side-table. Falls back to the 5-row sample size when
        // the exact count wasn't captured (e.g. the count query timed out).
        const dc = sd.docCount;
        if (typeof dc === 'number') {
          if (dc >= 1000)      score += 32;
          else if (dc >= 100)  score += 22;
          else if (dc >= 10)   score += 10;
          else if (dc <= 1)    score -= 25;
        } else if ((sd.rowCount || 0) >= 5) {
          score += 18;
        } else if ((sd.rowCount || 0) <= 1) {
          score -= 25;
        }
      }
      return { t, score };
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, n)
    .map(item => item.t);
}

// Metabase often returns 0 fields for MongoDB collections. Backfill the field
// list from the scan cache (real column names read from sample rows) so the
// query builder can find status/id/name fields.
export function enrichTableFields(table, scanData) {
  if (!table) return table;
  const scan = scanData?.get?.(table.name);
  let out = table;
  // Backfill field list from the scanned column names when Metabase gave none.
  if ((table.fields || []).length === 0 && scan?.cols?.length) {
    out = { ...out, fields: scan.cols.map(name => ({ name })) };
  }
  // Attach the collection's REAL status vocabulary + status field (captured by
  // the deep scan) so the query builder can filter on ground-truth values
  // instead of a guessed regex. Non-enumerable-ish extra props; harmless if absent.
  if (scan && (scan.statusValues || scan.statusField)) {
    if (out === table) out = { ...out };
    out._statusValues = scan.statusValues;
    out._statusField  = scan.statusField;
    out._docCount     = scan.docCount;
  }
  return out;
}

export function pickBestTable(question, schema) {
  const tops = getTopCollections(question, schema, 1);
  return tops[0] || null;
}

// ── ID EXTRACTION HELPERS ─────────────────────────────────────────────────

// Extract a 24-char MongoDB ObjectId even when the user glued it to the next
// word (e.g. "...df198e23and how many" → "6a4f...e23"). We match exactly 24 hex
// chars that are NOT preceded by another hex char and NOT followed by 8+ more
// hex chars — so a real ObjectId is found whether or not it's space-separated,
// while a longer hash (40+ hex) is not mistakenly truncated.
export function extractObjectId(question) {
  const strict = question.match(/\b([0-9a-f]{24})\b/i);      // clean, space-delimited
  if (strict) return strict[1].toLowerCase();
  const glued = question.match(/(?<![0-9a-f])([0-9a-f]{24})(?![0-9a-f]{8})/i); // glued to a word
  return glued ? glued[1].toLowerCase() : null;
}

export function extractSpecificId(question) {
  const oid = extractObjectId(question);
  if (oid) return oid;
  // UUID
  const muuid = question.match(/\b([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\b/i);
  if (muuid) return muuid[1].toLowerCase();
  // Any long hex-like token (16+ chars)
  const mhex = question.match(/\b([0-9a-f]{16,})\b/i);
  if (mhex) return mhex[1].toLowerCase();
  return null;
}

// Unified filter extractor — handles hex IDs, emails, quoted names, and named references
export function extractSpecificFilter(question) {
  const q = question.trim();

  // 1. Hex / UUID / ObjectId (highest confidence) — handles glued-to-word ids too
  const oid = extractObjectId(q);
  if (oid) return { type: 'id', value: oid };
  const muuid = q.match(/\b([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\b/i);
  if (muuid) return { type: 'id', value: muuid[1].toLowerCase() };
  const mhex = q.match(/\b([0-9a-f]{16,})\b/i);
  if (mhex) return { type: 'id', value: mhex[1].toLowerCase() };

  // 2. Email address
  const emailMatch = q.match(/\b([\w.+-]+@[\w-]+\.\w+)\b/i);
  if (emailMatch) return { type: 'email', value: emailMatch[1] };

  // 3. Quoted string (explicit name the user wrapped in quotes)
  const quotedMatch = q.match(/["']([^"']{2,60})["']/);
  if (quotedMatch) return { type: 'name', value: quotedMatch[1] };

  // Words that should NOT be treated as specific names/values (status words,
  // descriptors, plurals, question words). Prevents "conflict"/"failed"/"all"
  // etc. from being mistaken for a specific workspace/user name.
  const GENERIC = /^(information|details|status|state|error|errors|data|id|name|info|records?|all|any|the|for|with|about|this|that|in|from|to|of|a|an|is|are|what|which|how|show|give|get|find|list|tell|please|can|you|me|i|my|specific|particular|certain|given|mentioned|user|users|workspace|workspaces|channel|channels|job|jobs|migration|migrations|message|messages|file|files|folder|folders|active|failed|failure|fail|complete|completed|pending|running|conflict|conflicts|conflicted|success|successful|broken|issue|issues|problem|problems|sync|synced|migrated|done|inprogress|progress|suspended|warning|warnings|processed|notprocessed|source|destination|collaborator|collaborators|owner|owners|latest|recent|today|yesterday|every|each|current|their|its|his|her|we|us|our|or|and)$/i;

  const notGeneric = s => s && !GENERIC.test(s.trim());

  // 4. Specific workspace by name — SINGULAR only ("workspace pepperwood",
  //    "pepperwood workspace"). Plural "workspaces" is a general list, not a name.
  const wsPatterns = [
    /(?:for|about|regarding|of)\s+workspace\s+(?:named?|called?|id\s+)?["']?([A-Za-z0-9][\w\-\.]{1,50})["']?/i,
    /\bworkspace\s+(?:named?|called?|id\s+|with\s+name\s+)?["']?([A-Za-z0-9][\w\-\.]{1,50})["']?/i,
    /\b([A-Za-z0-9][\w\-\.]{1,50})\s+workspace(?![a-z])/i,
  ];
  for (const pat of wsPatterns) {
    const m = q.match(pat);
    if (m && notGeneric(m[1])) return { type: 'workspace_name', value: m[1].trim() };
  }

  // 5. Specific user by name/email — SINGULAR only. Plural "users" is a list.
  const userPatterns = [
    /(?:for|about|regarding)\s+user\s+(?:named?|called?|id\s+)?["']?([A-Za-z0-9][\w\-\.@]{1,60})["']?/i,
    /\buser\s+(?:named?|called?|id\s+|with\s+(?:name|email)\s+)?["']?([A-Za-z0-9][\w\-\.@]{1,60})["']?/i,
  ];
  for (const pat of userPatterns) {
    const m = q.match(pat);
    if (m && notGeneric(m[1])) return { type: 'user_name', value: m[1].trim() };
  }

  return null;
}

// Build a MongoDB $match condition for a name/email filter across relevant fields
export function buildNameMatchCondition(fields, filterType, value) {
  const fieldNames = fields.map(f => f.name);
  // No field metadata → can't build a name match. Return match-all ({}) so the
  // caller never emits an empty $or/$and (which MongoDB rejects with BadValue).
  if (!fieldNames.length) return {};
  let targetFields = [];

  if (filterType === 'email') {
    targetFields = fieldNames.filter(f => /email|mail/i.test(f));
    if (!targetFields.length) targetFields = fieldNames.filter(f => /owner|from|to/i.test(f)).slice(0, 3);
  } else if (filterType === 'workspace_name') {
    // Prefer exact workspace name fields
    targetFields = fieldNames.filter(f =>
      /^workspacename$|^WorkSpaceName$|^name$|^Name$|workspace.*name|workspacename/i.test(f)
    );
    if (!targetFields.length) targetFields = fieldNames.filter(f => /name|title/i.test(f)).slice(0, 4);
  } else if (filterType === 'user_name') {
    targetFields = fieldNames.filter(f => /^name$|displayname|username|fullname|firstname|lastname/i.test(f));
    if (!targetFields.length) targetFields = fieldNames.filter(f => /name/i.test(f)).slice(0, 3);
  } else {
    targetFields = fieldNames.filter(f => /name|title|label/i.test(f)).slice(0, 4);
  }

  if (!targetFields.length) targetFields = fieldNames.slice(0, 2);

  const useRegex = filterType !== 'id';
  if (targetFields.length === 1) {
    return useRegex
      ? { [targetFields[0]]: { '$regex': value, '$options': 'i' } }
      : { [targetFields[0]]: value };
  }
  return {
    '$or': targetFields.map(f =>
      useRegex
        ? { [f]: { '$regex': value, '$options': 'i' } }
        : { [f]: value }
    )
  };
}

export function findMatchingIdField(fields, question) {
  const q = question.toLowerCase();
  const fieldNames = fields.map(f => f.name);

  // Context-specific priority fields
  const contextMatches = [
    [/workspace/, ['UniqueWorkSpaceId', 'workspaceId', 'workspace_id', 'WorkspaceId']],
    [/user(?!.*workspace)/, ['UserId', 'userId', 'user_id']],
    [/job/, ['JobId', 'jobId', 'job_id']],
    [/channel/, ['ChannelId', 'channelId', 'channel_id', 'SrcChannelId']],
    [/message/, ['MessageId', 'messageId', 'message_id']],
    [/migration|migrat/, ['MigrationId', 'migrationId', 'migration_id']],
  ];

  for (const [pattern, preferred] of contextMatches) {
    if (pattern.test(q)) {
      for (const pf of preferred) {
        const found = fields.find(f => f.name.toLowerCase() === pf.toLowerCase());
        if (found) return found.name;
        // partial match
        const partial = fields.find(f => f.name.toLowerCase().includes(pf.toLowerCase()));
        if (partial) return partial.name;
      }
    }
  }

  // No context match — try _id first (most reliable unique key in MongoDB)
  if (fieldNames.includes('_id')) return '_id';
  // Then any field ending in Id
  const anyId = fields.find(f => /id$/i.test(f.name));
  return anyId ? anyId.name : '_id';
}

export function findErrorField(fields) {
  return (
    // Most specific: an explicit error DESCRIPTION / category field
    fields.find(f => /errordescription|error_description|errorcategory|error_category|errortype|error_type/i.test(f.name)) ||
    fields.find(f => /usererror|usererrormessage|error_message|errormessage|exceptionmessage|exception/i.test(f.name)) ||
    fields.find(f => /failreason|fail_reason|failurereason|conflictreason|conflict_reason|conflictdescription/i.test(f.name)) ||
    fields.find(f => /reason|cause|detail/i.test(f.name)) ||
    fields.find(f => /error|conflict|message/i.test(f.name))
  );
}

// Map the STATUS the user asked about → a case-insensitive regex over status
// values. Lets "processed / migrated" mean PROCESSED, "not processed / pending"
// mean NOT_PROCESSED, etc. Returns '' when no specific status was requested.
// NOTE: "not processed" is checked BEFORE "processed" (it contains "process").
export function statusFilterRegex(question, filterValue = '') {
  const s = `${filterValue} ${question}`.toLowerCase();
  if (/\bnot[ _]?process|unprocess|pending|not[ _]?migrat|did\s?n.?t migrat|not[ _]?complet|not[ _]?done|yet to|remaining|left to/i.test(s))
    return 'not_?process|pending|unprocess|not_?migrat|queued';
  if (/process|migrat|complet|success|\bdone\b|finished/i.test(s))
    return 'process|complet|success|migrat';
  if (/conflict/i.test(s)) return 'conflict';
  if (/fail|error|broken/i.test(s)) return 'fail|error';
  if (/inactive|disabled|suspend/i.test(s)) return 'inactive|disabled|suspend';
  if (/\bactive\b|enabled/i.test(s)) return 'active|enabled';
  return '';
}

// Does the question ask for the REASON / ERROR DESCRIPTION (why it failed or
// conflicted, what the error was)? Matches many phrasings — "why did it
// conflict", "reason for failure", "give me the error description", "what error",
// "show me the errors", "what went wrong", "explain the conflict", "diagnose" —
// but NOT a plain count like "how many errors".
export function isReasonQuestion(question) {
  const q = (question || '').toLowerCase();
  const explicit = /\bwhy\b|\breasons?\b|\bcaus(e|es|ed|ing)\b|error[_ ]?(description|desc|message|msg|detail|details|info|reason|text)|fail(ure|ed)?[_ ]?reason|reason (for|why|behind|of)|what went wrong|went wrong|what.*(caused|went wrong)|explain.*(fail|conflict|error)|diagnos/i.test(q);
  if (explicit) return true;
  // "errors"/"error" asked as something to SHOW (not counted)
  if (/\berrors?\b/i.test(q) && !/\bhow many\b|\bcount\b|\bnumber of\b/i.test(q)
      && /\b(show|list|give|provide|what|which|see|view|get|display|tell|any|the)\b/i.test(q)) return true;
  return false;
}

// ── FORECAST / ETA (estimate when a migration will finish) ─────────────────

// Is the user asking WHEN a migration will finish / how long is left / an ETA?
export function isForecastQuestion(question) {
  const q = (question || '').toLowerCase();
  return (
    /\b(when|how long|how many days|how much time|eta|estimate[d]?|estimation|expected|forecast|by when|time (left|remaining)|days (left|remaining)|finish|complete[d]?|completion)\b/.test(q) &&
    /\b(migrat|process|remaining|left|pending|progress|stuck|finish|complete|done|data|messages?|files?|folders?|items?)\b/.test(q)
  ) || /\bwhen will .* (finish|complete|be done|migrat|process)/.test(q)
     || /\bhow long (until|till|to|before)\b/.test(q);
}

// Find the best timestamp field to measure processing time from. Prefers a
// "processed/updated/completed" time (reflects real progress), then created/start,
// then any generic date/time field.
export function findTimeField(fields = []) {
  const pick = re => fields.find(f => re.test(f.name));
  return pick(/processed_?at|processed_?time|process_?time|processedon/i)
      || pick(/updated_?at|updated_?time|modified_?time|last_?modified|modified_?at|updatedon|lastupdated/i)
      || pick(/completed_?at|completed_?time|finished_?at|finish_?time|end_?time|end_?date|completedon/i)
      || pick(/created_?at|created_?time|create_?time|start_?time|start_?date|createdon|createddate/i)
      || pick(/timestamp|datetime|\bdate\b|\btime\b/i)
      || null;
}

// Build a MongoDB $match that finds a document by an id VALUE. Matching EVERY
// id-like field is a full collection scan per field (very slow on big
// collections), so we match the CONTEXT-relevant id field(s) when the question
// names the entity ("userId", "workspace", "job"…), plus the _id ObjectId. Only
// when we can't tell do we fall back to a small set of id fields.
export function buildIdMatchCondition(fields = [], value, question = '') {
  const is24hex = /^[0-9a-f]{24}$/i.test(value);
  const idFields = fields.map(f => f.name).filter(n => /id$/i.test(n) && n.toLowerCase() !== '_id');
  const q = (question || '').toLowerCase();

  // Rank id fields by how well they fit the entity named in the question.
  const groups = [];
  if (/\buser|owner|member|agent|people|person|email\b/.test(q)) groups.push(/^user_?id$/i, /owner.*id$/i, /member_?id$/i, /agent_?id$/i);
  if (/workspace|wsid|\bspace\b|tenant|org/.test(q))              groups.push(/workspace_?id$/i, /movework.*id$/i, /uniquework.*id$/i, /space_?id$/i);
  if (/\bjob\b/.test(q))                                          groups.push(/job_?id$/i);
  if (/channel|room/.test(q))                                     groups.push(/channel_?id$/i, /srcchannelid$/i);
  if (/message|msg|chat|conversation/.test(q))                    groups.push(/message.*id$/i, /msg.*id$/i);
  if (/migration|migrat|transfer/.test(q))                        groups.push(/migration_?id$/i, /transfer_?id$/i);
  const rank = n => { for (let i = 0; i < groups.length; i++) if (groups[i].test(n)) return groups.length - i; return -1; };

  const matched = idFields.filter(n => rank(n) >= 0).sort((a, b) => rank(b) - rank(a));

  let picked;
  if (matched.length) {
    picked = matched.slice(0, 3);            // context is clear → just those fields
  } else {
    // No entity context — use a bounded set of the most common id fields so the
    // $or stays cheap instead of scanning on every id field.
    const common = idFields.filter(n => /^(user|owner|workspace|movework|uniquework|job|channel|message|migration|transfer).*id$/i.test(n));
    picked = (common.length ? common : idFields).slice(0, 4);
  }

  const conds = picked.map(n => ({ [n]: value }));
  if (is24hex) conds.push({ _id: { '$oid': value } });
  if (!conds.length) conds.push({ [findMatchingIdField(fields, question) || '_id']: value });
  return conds.length === 1 ? conds[0] : { '$or': conds };
}

// Parse a timestamp cell (ISO string, epoch seconds, or epoch ms) → epoch ms.
export function parseTimestampMs(v) {
  if (v == null || v === '') return null;
  if (typeof v === 'number') return v < 1e12 ? v * 1000 : v; // seconds vs ms heuristic
  if (/^\d+$/.test(String(v))) { const n = parseInt(v, 10); return n < 1e12 ? n * 1000 : n; }
  const t = Date.parse(String(v));
  return isNaN(t) ? null : t;
}

// From a collection's status breakdown ([{value,count}]) split the counts into
// the buckets a forecast needs. Buckets may overlap slightly (e.g.
// "PROCESSED_WITH_CONFLICTS" counts as both processed and conflict) — that's
// intentional for reporting; the ETA only uses processed + remaining.
export function classifyForecastCounts(statusValues = []) {
  const sv = Array.isArray(statusValues) ? statusValues : [];
  const total = sv.reduce((a, s) => a + (Number(s.count) || 0), 0);
  // Bucket every value canonically (mutually exclusive), then tally.
  const b = { processed: 0, inProgress: 0, notProcessed: 0, conflict: 0, failed: 0, retry: 0, paused: 0, cancelled: 0, warning: 0, empty: 0, other: 0 };
  for (const s of sv) b[classifyStatusValue(s.value)] += (Number(s.count) || 0);
  return {
    total,
    processed: b.processed,
    inProgress: b.inProgress,
    notProcessed: b.notProcessed,
    conflict: b.conflict,
    failed: b.failed,
    retry: b.retry,
    paused: b.paused,
    cancelled: b.cancelled,
    warning: b.warning,
    empty: b.empty,
    // Still to finish = not-processed + in-progress + retry + paused (paused/
    // suspended will resume). Cancelled/failed/empty won't auto-complete.
    remaining: b.notProcessed + b.inProgress + b.retry + b.paused,
  };
}

// Attach a percentage-of-total to each status value, sorted by count desc.
export function withPercentages(statusValues = []) {
  const sv = Array.isArray(statusValues) ? statusValues : [];
  const total = sv.reduce((a, s) => a + (Number(s.count) || 0), 0) || 1;
  return sv
    .map(s => ({ value: s.value, count: Number(s.count) || 0, pct: Math.round(((Number(s.count) || 0) / total) * 1000) / 10 }))
    .sort((a, b) => b.count - a.count);
}

// Estimate completion time from processed count, remaining count, and the time
// span over which the processed items were handled. Pure math — no guessing.
//   processed  : items already done
//   remaining  : items still to process (in-progress + not-processed)
//   firstMs/lastMs : min/max processing timestamp (epoch ms) for this workspace
//   nowMs      : current time (epoch ms)
// Returns { ok, done, reason, perDay, etaMs, completionMs, elapsedMs }.
export function computeForecast({ processed = 0, remaining = 0, firstMs = null, lastMs = null, nowMs = 0 }) {
  if (remaining <= 0) return { ok: true, done: true };
  if (processed <= 0) return { ok: false, reason: 'nothing has finished processing yet, so there is no rate to project from' };
  const endRef = lastMs || nowMs;
  const elapsedMs = (endRef && firstMs) ? (endRef - firstMs) : 0;
  if (!elapsedMs || elapsedMs <= 0) return { ok: false, reason: 'there are no processing timestamps to measure a rate from' };
  const ratePerMs = processed / elapsedMs;        // items per ms
  if (!isFinite(ratePerMs) || ratePerMs <= 0) return { ok: false, reason: 'the processing rate could not be determined' };
  const etaMs = remaining / ratePerMs;            // ms to clear the remaining items
  return {
    ok: true, done: false,
    perDay: ratePerMs * 86400000,
    etaMs,
    completionMs: nowMs + etaMs,
    elapsedMs,
  };
}

// Human phrasing for a duration in ms → "3 days", "5 hours", "about 2 weeks".
export function humanizeDuration(ms) {
  if (ms == null || !isFinite(ms) || ms <= 0) return 'less than an hour';
  const mins = ms / 60000, hours = ms / 3600000, days = ms / 86400000;
  if (days >= 14) return `about ${Math.round(days / 7)} weeks`;
  if (days >= 1)  return `about ${Math.round(days)} day${Math.round(days) !== 1 ? 's' : ''}`;
  if (hours >= 1) return `about ${Math.round(hours)} hour${Math.round(hours) !== 1 ? 's' : ''}`;
  return `about ${Math.max(1, Math.round(mins))} minute${Math.round(mins) !== 1 ? 's' : ''}`;
}

// ── SINGLE-TABLE QUERY BUILDER ─────────────────────────────────────────────
// Builds a MongoDB pipeline OR SQL query for a SPECIFIC table.
// `hints` (optional, from the LLM) makes intent robust to phrasing:
//   hints.operation: 'count' | 'list' | 'breakdown' | 'why' | 'filter' | 'recent'
//   hints.filterValue: a value to filter by, e.g. 'conflict', 'failed', 'active'
export function buildQueryForTable(question, table, engine, hints = {}) {
  if (!table) return null;
  const isMongo = (engine || '').toLowerCase().includes('mongo');
  const fields   = table.fields || [];
  const q        = question.toLowerCase();

  // The LLM classifies the OPERATION regardless of how the user phrased it
  // ("how many" / "count" / "tally" / "number of" all → operation:count). Fall
  // back to keyword regex when no hint is supplied.
  const op   = (hints.operation || '').toLowerCase();
  const fval = (hints.filterValue || '').toString().toLowerCase().trim();

  // A reason/error-description ask ALWAYS means "why" — even if the LLM mislabeled
  // the operation as count/breakdown — so "give me the error description" reads
  // the reasons instead of returning a number.
  const isReason = op === 'why' || isReasonQuestion(q);
  const isWhy    = isReason;
  const isCount  = !isReason && (op ? op === 'count'     : /how many|count|total|number of|tally/i.test(q));
  const isStatus = !isReason && (op ? op === 'breakdown' : /status breakdown|by status|group.*status|distribution|breakdown|summary/i.test(q));
  const isRecent = op ? op === 'recent'    : /recent|latest|last|newest|today|yesterday/i.test(q);
  // A value-filter (e.g. only failed / conflict / active). Triggered by an LLM
  // filter hint, or by keywords in the text.
  const isFilter = (op === 'filter' && !!fval) || (!op && /fail|error|broken|issue|problem|conflict|inactive|disabled|suspended/i.test(q));
  const isFailed = isFilter; // kept name for the branch below
  // Complete-list requests → fetch everything (up to a high cap).
  const wantsAll = op === 'list' || /\b(all|entire|every|everyone|full|complete|whole|each)\b|list all|provide.*(all|list)|show.*all/i.test(q);
  const LIST_LIMIT = wantsAll ? 10000 : 200;

  // ── SPECIFIC FILTER: ID / name / email (highest priority) ───────────────
  const specificFilter = extractSpecificFilter(question);
  if (specificFilter && isMongo) {
    const { type, value } = specificFilter;
    const errorField = findErrorField(fields);
    const statusField = fields.find(f => /^process_?status$|^status$|^state$/i.test(f.name))
                     || fields.find(f => /status|state|progress/i.test(f.name));

    // Build the id/name match condition.
    let idMatch;
    if (type === 'id') {
      // We don't know WHICH field holds this id (workSpaceId, uniqueWorkSpaceId,
      // messageMoveWorkSpaceId in a per-message collection, jobId, or the _id
      // ObjectId). Match the value across ALL id-like fields + _id as ObjectId —
      // only the field that actually holds it will match.
      const is24hex = /^[0-9a-f]{24}$/i.test(value);
      const idFields = fields.map(f => f.name).filter(n => /id$/i.test(n) && n.toLowerCase() !== '_id');
      const conds = idFields.map(n => ({ [n]: value }));
      if (is24hex) conds.push({ _id: { '$oid': value } });
      if (!conds.length) conds.push({ [findMatchingIdField(fields, question) || '_id']: value });
      idMatch = conds.length === 1 ? conds[0] : { '$or': conds };
    } else {
      idMatch = buildNameMatchCondition(fields, type, value);
    }

    // Data-type discriminator: FileFolderInfo (and similar) mix FILES and FOLDERS
    // in one collection via a `folder` boolean. If the user asked specifically for
    // "files" or "folders", filter to that type so the counts are separate and
    // "files" never includes folders (this is the "entire count" bug).
    const folderFlag = fields.find(f => /^folder$/i.test(f.name));
    const wantsFolders = /\bfolders?\b/i.test(q);
    const wantsFiles   = /\bfiles?\b/i.test(q) && !wantsFolders;
    const typeFilter = folderFlag
      ? (wantsFolders ? { [folderFlag.name]: true } : wantsFiles ? { [folderFlag.name]: false } : null)
      : null;

    let pipeline, explanation, queryType = 'filter';

    if (isWhy && errorField) {
      // "why did it fail/conflict" → group the matched records by their error
      // reason. If the question is specifically about conflict/failure AND there's
      // a status field, restrict to those statuses first so successful items don't
      // drown out the real reasons (e.g. per-message MessageEachFiles collections).
      const wantsBad = /conflict|fail|error|issue|problem/i.test(q);
      const match = (wantsBad && statusField)
        ? { '$and': [idMatch, { [statusField.name]: { '$regex': 'conflict|fail|error', '$options': 'i' } }] }
        : idMatch;
      pipeline = [
        { '$match': match },
        { '$group': { '_id': `$${errorField.name}`, 'count': { '$sum': 1 } } },
        { '$sort': { 'count': -1 } },
        { '$limit': 30 }
      ];
      explanation = `Error reasons for ${type} "${value}" grouped by ${errorField.name}`;
      queryType = 'aggregate';
    } else if (statusFilterRegex(q, hints.filterValue) && statusField) {
      // The user asked about a SPECIFIC status ("how much PROCESSED / migrated",
      // "the NOT_PROCESSED ones", "failed", "conflict"). Filter to exactly that
      // status and COUNT it — so "processed" never returns not-processed data.
      // Prefer EXACT status values from the collection's real vocabulary (captured
      // by the deep scan) via $in; fall back to the guessed regex when unknown.
      const exact = matchStatusValues(table._statusValues, statusIntent(q, hints.filterValue));
      const statusCond = exact.length
        ? { [statusField.name]: { '$in': exact } }
        : { [statusField.name]: { '$regex': statusFilterRegex(q, hints.filterValue), '$options': 'i' } };
      const conds = [idMatch, statusCond];
      if (typeFilter) conds.push(typeFilter);   // files-only or folders-only
      pipeline = [{ '$match': { '$and': conds } }, { '$count': 'total' }];
      explanation = `Count of ${wantsFolders ? 'folders' : wantsFiles ? 'files' : 'items'} for ${type} "${value}" with status ${exact.length ? `in [${exact.join(', ')}]` : `~ "${statusFilterRegex(q, hints.filterValue)}"`}`;
      queryType = 'aggregate';
    } else if ((isCount || isStatus || /how much|migrated|processed|progress/i.test(q)) && statusField) {
      // Generic "status of workspace X" (no specific status named) → full breakdown.
      pipeline = [
        { '$match': idMatch },
        { '$group': { '_id': `$${statusField.name}`, 'count': { '$sum': 1 } } },
        { '$sort': { 'count': -1 } }
      ];
      explanation = `${table.name} for ${type} "${value}" grouped by ${statusField.name}`;
      queryType = 'aggregate';
    } else {
      pipeline = [{ '$match': idMatch }, { '$limit': 50 }];
      explanation = `Records in ${table.name} where ${type} matches "${value}"`;
    }

    return {
      query: JSON.stringify(pipeline),
      collection: table.name,
      explanation,
      tables_used: [table.name],
      query_type: queryType,
      isMongo: true
    };
  }

  if (isMongo) {
    let pipeline, explanation, queryType = 'list';

    if (isCount) {
      // "How many <entity>" = COUNT DOCUMENTS. Only SUM a numeric field when the
      // user explicitly asks to total a quantity (messages/files/size). Summing a
      // per-record "TotalMessage" field for "how many workspaces" gives wrong data.
      const wantsSum = /\b(sum|total number of|how many (messages|files|items|records processed))\b/i.test(q);
      const numericField = wantsSum && fields.find(f => /^(total|num|user_count|message_count|member_count|processedcount)/i.test(f.name));

      // If the user named a STATUS ("how many PROCESSED / conflict / not migrated
      // files"), COUNT only that status — not the whole collection. This is the
      // "you gave me the entire count instead of the status I asked for" fix, now
      // on the generic (no id/name) path too. Prefer exact scanned values.
      const cIntent    = statusIntent(q, fval);
      const cStatusF   = pickStatusFieldName((fields || []).map(f => f.name));
      const cExact     = cIntent ? matchStatusValues(table._statusValues, cIntent) : [];
      // Files-vs-folders discriminator (FileFolderInfo mixes both via `folder`).
      const cFolderF   = fields.find(f => /^folder$/i.test(f.name));
      const cWantsFold = /\bfolders?\b/i.test(q);
      const cWantsFile = /\bfiles?\b/i.test(q) && !cWantsFold;
      const cTypeCond  = cFolderF ? (cWantsFold ? { [cFolderF.name]: true } : cWantsFile ? { [cFolderF.name]: false } : null) : null;

      if (numericField) {
        pipeline = [{ "$group": { "_id": null, "total": { "$sum": `$${numericField.name}` } } }];
        explanation = `Sum of ${numericField.name} in ${table.name}`;
      } else if (cIntent && cStatusF) {
        const statusCond = cExact.length
          ? { [cStatusF]: { '$in': cExact } }
          : { [cStatusF]: { '$regex': statusFilterRegex(q, fval), '$options': 'i' } };
        const conds = [statusCond];
        if (cTypeCond) conds.push(cTypeCond);
        pipeline = [{ '$match': conds.length === 1 ? conds[0] : { '$and': conds } }, { '$count': 'total' }];
        explanation = `Count of ${cWantsFold ? 'folders' : cWantsFile ? 'files' : 'items'} in ${table.name} with ${cStatusF} ${cExact.length ? `in [${cExact.join(', ')}]` : `~ "${statusFilterRegex(q, fval)}"`}`;
      } else if (cTypeCond) {
        // "how many files/folders" (no status) → count just that type.
        pipeline = [{ '$match': cTypeCond }, { '$count': 'total' }];
        explanation = `Count of ${cWantsFold ? 'folders' : 'files'} in ${table.name}`;
      } else {
        pipeline = [{ "$count": "total" }];
        explanation = `Total documents in ${table.name}`;
      }
      queryType = 'aggregate';
    } else if (isStatus) {
      const statusField = fields.find(f => /^process_?status$|^migration_?status$|^job_?status$|^status$/i.test(f.name))
                       || fields.find(f => /process_?status|migration_?status/i.test(f.name))
                       || fields.find(f => /status$/i.test(f.name))
                       || fields.find(f => /status|state|progress|stage/i.test(f.name));
      if (statusField) {
        pipeline = [
          { "$group": { "_id": `$${statusField.name}`, "count": { "$sum": 1 } } },
          { "$sort": { "count": -1 } }
        ];
        explanation = `${table.name} grouped by ${statusField.name}`;
        queryType = 'aggregate';
      } else {
        pipeline = [{ "$limit": 100 }];
        explanation = `All records from ${table.name}`;
      }
    } else if (isWhy) {
      // "Why did it go to conflict / fail?" → read the ERROR DESCRIPTION field and
      // group the conflict/failed records by their reason, most common first, so
      // we return the ACTUAL reasons (e.g. "Missing entry in CFOAuthCredential…")
      // rather than a bare count. Works with or without a specific workspace id.
      const errorField = findErrorField(fields);
      const statusField = fields.find(f => /^process_?status$|^status$|^state$/i.test(f.name))
                       || fields.find(f => /status|state|progress/i.test(f.name));
      if (errorField) {
        const wantsBad = /conflict|fail|error|issue|problem/i.test(q);
        const match = (wantsBad && statusField)
          ? { [statusField.name]: { '$regex': 'conflict|fail|error', '$options': 'i' } }
          : null;
        pipeline = [
          ...(match ? [{ '$match': match }] : []),
          { '$group': { '_id': `$${errorField.name}`, 'count': { '$sum': 1 } } },
          { '$sort': { 'count': -1 } },
          { '$limit': 50 }
        ];
        explanation = `Conflict/failure reasons in ${table.name} grouped by ${errorField.name}`;
        queryType = 'aggregate';
      } else {
        const sf = fields.find(f => /status|state/i.test(f.name));
        pipeline = sf
          ? [{ '$match': { [sf.name]: { '$regex': 'conflict|fail|error', '$options': 'i' } } }, { '$limit': 50 }]
          : [{ '$limit': 50 }];
        explanation = `Conflict/failed records in ${table.name}`;
      }
    } else if (isFailed) {
      const statusField = fields.find(f => /^(processstatus|migrationstatus|jobstatus|status|state)$/i.test(f.name))
                       || fields.find(f => /status|state|progress|active/i.test(f.name));
      if (statusField) {
        // Prefer EXACT status values from the collection's real vocabulary
        // (captured by the deep scan) so we match what the collection actually
        // stores. Fall back to a keyword-derived regex when the vocabulary
        // wasn't captured.
        const exact = matchStatusValues(table._statusValues, statusIntent(q, fval));
        let matchCond, explainVal;
        if (exact.length) {
          matchCond = { [statusField.name]: { '$in': exact } };
          explainVal = `in [${exact.join(', ')}]`;
        } else {
          let terms = [];
          if (fval) {
            terms = [fval.replace(/[^a-z0-9]+/g, '')];        // e.g. "active", "failed", "conflict"
          } else {
            if (/fail|error|broken|issue|problem/i.test(q)) terms.push('fail', 'error');
            if (/conflict/i.test(q)) terms.push('conflict');
            if (/\binactive|disabled|suspended\b/i.test(q)) terms.push('inactive', 'disabled', 'suspended');
            else if (/\bactive|enabled\b/i.test(q)) terms.push('active', 'enabled');
          }
          if (!terms.length) terms.push('fail', 'error', 'conflict');
          const regex = [...new Set(terms.filter(Boolean))].join('|');
          matchCond = { [statusField.name]: { '$regex': regex, '$options': 'i' } };
          explainVal = `matches "${regex}"`;
        }
        pipeline = [
          { "$match": matchCond },
          { "$limit": LIST_LIMIT }
        ];
        explanation = `Records in ${table.name} where ${statusField.name} ${explainVal}`;
      } else {
        pipeline = [{ "$limit": LIST_LIMIT }];
        explanation = `Records from ${table.name}`;
      }
    } else if (isRecent) {
      const dateField = fields.find(f => /created_at|updated_at|timestamp|date|time|createdAt|updatedAt/i.test(f.name))
                     || fields.find(f => /created|updated|date|time/i.test(f.name));
      pipeline = dateField
        ? [{ "$sort": { [dateField.name]: -1 } }, { "$limit": wantsAll ? LIST_LIMIT : 50 }]
        : [{ "$limit": wantsAll ? LIST_LIMIT : 50 }];
      explanation = `Recent records from ${table.name}`;
    } else {
      // List: project visible fields
      if (fields.length > 0) {
        const proj = {};
        fields.slice(0, 20).forEach(f => { proj[f.name] = 1; });
        pipeline = [{ "$project": proj }, { "$limit": LIST_LIMIT }];
      } else {
        pipeline = [{ "$limit": LIST_LIMIT }];
      }
      explanation = `Data from ${table.name}`;
    }

    return {
      query: JSON.stringify(pipeline),
      collection: table.name,
      explanation,
      tables_used: [table.name],
      query_type: queryType,
      isMongo: true
    };
  }

  // ── SQL path ──
  function qid(n) {
    const e = (engine || '').toLowerCase();
    if (e.includes('mysql') || e.includes('maria')) return `\`${n}\``;
    if (e.includes('sqlserver') || e.includes('mssql')) return `[${n}]`;
    return `"${n}"`;
  }

  const tbl = qid(table.name);
  const colList = fields.length > 0 ? fields.slice(0, 20).map(f => qid(f.name)).join(', ') : '*';

  if (isCount) {
    const numField = fields.find(f => /^(count|total|num|user_count|message_count)/i.test(f.name));
    if (numField) return { sql: `SELECT SUM(${qid(numField.name)}) AS total FROM ${tbl}`, explanation: `Sum of ${numField.name}`, tables_used: [table.name], query_type: 'aggregate', isMongo: false };
    return { sql: `SELECT COUNT(*) AS total_count FROM ${tbl}`, explanation: `Total rows in ${table.name}`, tables_used: [table.name], query_type: 'aggregate', isMongo: false };
  }
  if (isStatus) {
    const sf = fields.find(f => /status|state|progress|stage|type/i.test(f.name));
    if (sf) return { sql: `SELECT ${qid(sf.name)}, COUNT(*) AS count FROM ${tbl} GROUP BY ${qid(sf.name)} ORDER BY count DESC`, explanation: `Status breakdown`, tables_used: [table.name], query_type: 'aggregate', isMongo: false };
  }
  const df = fields.find(f => /created|updated|date|time|timestamp/i.test(f.name));
  const order = isRecent && df ? ` ORDER BY ${qid(df.name)} DESC` : '';
  return { sql: `SELECT ${colList} FROM ${tbl}${order} LIMIT 100`, explanation: `Data from ${table.name}`, tables_used: [table.name], query_type: 'list', isMongo: false };
}

// Backward-compat wrappers
export function buildMongoQuery(question, schema) {
  const table = pickBestTable(question, schema);
  return buildQueryForTable(question, table, 'mongo');
}

export function buildKeywordSQL(question, schema) {
  const table = pickBestTable(question, schema);
  return buildQueryForTable(question, table, schema?.engine || 'postgres');
}

// Is this asking about what collections/tables exist?
export function isSchemaListQuestion(question) {
  return /what (collection|table|database)s?( are| do| exist| is| does| have| available)|list (all )?(collection|table)|show (all )?(collection|table)|available (collection|table)|all (collection|table)s?/i.test(question);
}

// ── SCHEMA NAVIGATION Q&A ─────────────────────────────────────────────────
// Handles: "in which collection is X?", "where can I find Y?", "which table has Z?"

export function isSchemaNavigationQuestion(question) {
  const q = question.toLowerCase().trim();
  return (
    // "in which collection / table..."
    /in which (collection|table|db|database)/i.test(q) ||
    // "which collection has / contains / stores / holds..."
    /which (collection|table) (has|contains|holds|stores|keeps|have)/i.test(q) ||
    // "where can I find / check / see / look..."
    /where (can i |do i |should i |to )?(find|check|see|look|get|search|query|access)/i.test(q) ||
    // "what collection contains..."
    /what (collection|table) (contains|has|holds|stores)/i.test(q) ||
    // "where is X data", "where are X records"
    /where (is|are) (the )?\w+ (data|records|information|info|details)/i.test(q) ||
    // "which collection for X"
    /which collection (for|of|about|regarding)/i.test(q) ||
    // "tell me the collection", "find the collection"
    /(tell me|find|show) (the |which )?(collection|table) (for|that|where|with)/i.test(q) ||
    // "collection to check", "collection for checking"
    /collection (to|for) (check|find|see|get|view)/i.test(q)
  );
}

// Returns a human-readable description of what a collection stores
export function describeCollection(table, entity) {
  const n = (table.name || '').toLowerCase();
  const fields = (table.fields || []).map(f => f.name.toLowerCase());
  const hasField = (...names) => names.some(nm => fields.some(f => f.includes(nm)));

  // Name-based description lookup
  const descriptions = [
    [/user/,         'Stores user account records — includes identity fields like email, name, role, and workspace assignments. Use this to look up individual users, their roles, and account status.'],
    [/workspace/,    'Contains workspace (tenant/organization) records — each workspace represents a separate migration project or team environment. Fields typically include workspace ID, name, owner, status, and migration state.'],
    [/message/,      'Holds message records exchanged during migrations or system events — useful for tracking communication history, delivery status, and content between users or services.'],
    [/channel/,      'Stores channel records — a channel typically groups users or conversations within a workspace. Useful for understanding collaboration structure.'],
    [/migrat/,       'Tracks migration job records — each document represents a data migration task with source, destination, progress percentage, status (pending/running/completed/failed), and timestamps.'],
    [/conflict/,     'Records conflict events that occurred during migrations — contains workspace ID, conflict type, reason/error field, and resolution status. Query this to understand why a migration failed or conflicted.'],
    [/error|fail/,   'Logs error and failure events — includes error type, error message, affected resource, and timestamp. Use this to debug failures and find root causes.'],
    [/activity|log|audit/, 'Contains audit/activity logs — tracks who did what and when. Useful for compliance, debugging, and understanding usage patterns.'],
    [/credential|auth|token/, 'Stores authentication credentials, API tokens, or OAuth data — used to connect source/destination systems during migrations.'],
    [/file|attachment/, 'Holds file and attachment records — includes file name, size, type, owner, and migration status.'],
    [/folder/,       'Contains folder structure records — represents directory hierarchies from source systems being migrated.'],
    [/categor/,      'Stores category or classification records — used to group or tag other records for organisation.'],
    [/status|progress/, 'Tracks status and progress of operations — includes state transitions, percentage complete, and timestamps.'],
    [/api/,          'Logs API calls made to or from the system — includes endpoint, method, response code, and execution time.'],
  ];

  for (const [pattern, desc] of descriptions) {
    if (pattern.test(n)) return desc;
  }

  // Field-based fallback description
  const parts = [];
  if (hasField('email', 'username', 'name', 'user')) parts.push('user identity information');
  if (hasField('status', 'state', 'progress')) parts.push('status/progress tracking');
  if (hasField('error', 'reason', 'message', 'exception')) parts.push('error or event details');
  if (hasField('workspace', 'tenant', 'org')) parts.push('workspace/tenant context');
  if (hasField('created', 'updated', 'timestamp', 'date')) parts.push('timestamps');
  if (hasField('source', 'destination', 'target')) parts.push('migration source/destination info');

  if (parts.length) return `Contains ${parts.join(', ')}.`;
  return `General data collection with ${table.fields?.length || 0} fields.`;
}

export function answerSchemaNavigation(question, schema) {
  const tables = schema?.tables || [];
  const isMongo = (schema?.engine || '').toLowerCase().includes('mongo');
  const noun = isMongo ? 'collection' : 'table';

  if (!tables.length) {
    return `No ${noun}s are loaded yet. Select a database from the sidebar first.`;
  }

  // Score collections by how well they match the question
  const scored = tables
    .map(t => ({ t, score: scoreTable(t.name, question) }))
    .sort((a, b) => b.score - a.score);

  const topMatches = scored.filter(item => item.score > 0).slice(0, 5);

  // Extract the entity the user is asking about
  const q = question.toLowerCase();
  let entity = '';
  const entityPatterns = [
    [/user|member|agent|people|person|staff|employee/, 'user'],
    [/workspace|team|org|organization|tenant/, 'workspace'],
    [/message|chat|msg|conversation|post/, 'message'],
    [/channel|room|group/, 'channel'],
    [/migration|job|task|transfer/, 'migration job'],
    [/credential|auth|token|key|api|oauth/, 'credential'],
    [/activity|log|event|audit|history/, 'activity/log'],
    [/error|fail|exception|conflict/, 'error/conflict'],
    [/file|attachment|document|doc/, 'file'],
    [/status|progress|state/, 'status'],
    [/categor/, 'category'],
    [/api.?call|api.*log/, 'API call'],
  ];
  for (const [pattern, name] of entityPatterns) {
    if (pattern.test(q)) { entity = name; break; }
  }

  if (!topMatches.length) {
    const allList = tables.slice(0, 20).map(t => {
      const sampleFields = (t.fields || []).slice(0, 5).map(f => f.name).join(', ');
      return `- **${t.name}**${sampleFields ? ` — \`${sampleFields}\`` : ''}`;
    }).join('\n');
    return `I couldn't find a ${noun} that closely matches your question.\n\n**All available ${noun}s:**\n\n${allList}${tables.length > 20 ? `\n_...and ${tables.length - 20} more (see sidebar)_` : ''}\n\nExpand any ${noun} in the sidebar to see its full field list.`;
  }

  const entityLabel = entity ? `**${entity}** ` : '';
  const intro = `To find ${entityLabel}data, check the following ${noun}${topMatches.length > 1 ? 's' : ''}:`;

  const blocks = topMatches.map(({ t }, i) => {
    const fields = t.fields || [];
    const fieldNames = fields.map(f => f.name);

    // Key fields — first 10, shown as inline code
    const keyFields = fieldNames.slice(0, 10).map(f => `\`${f}\``).join(', ');
    const moreFields = fieldNames.length > 10 ? ` _(+${fieldNames.length - 10} more fields)_` : '';

    // Description of what the collection holds
    const description = describeCollection(t, entity);

    // What you can do with it
    const sampleQuery = entity
      ? `"Show me all ${entity} records in ${t.name}"`
      : `"Show me records from ${t.name}"`;

    const badge = i === 0 ? ' ✅ Best match' : '';

    return [
      `### ${t.name}${badge}`,
      `**What it stores:** ${description}`,
      `**Fields (${fields.length}):** ${keyFields || '_none_'}${moreFields}`,
      `**Try asking:** _${sampleQuery}_`,
    ].join('\n');
  });

  return `${intro}\n\n${blocks.join('\n\n---\n\n')}\n\n> You can also ask me to query any of these directly, e.g. _"Show me data from ${topMatches[0].t.name}"_.`;
}

// ── GENERAL KNOWLEDGE Q&A ─────────────────────────────────────────────────

export function isKnowledgeQuestion(question) {
  const q = question.toLowerCase().trim();
  if (/how many|count|total|show me|list (all|the)|give me (all|the)|fetch|find all|get all|number of|display all|select|what is the (status|count|number)/i.test(q)) return false;
  // Capabilities / help ("what can you do", "what can I ask", "help", "how do I use this")
  if (/\b(what can (you|i|it)|what (kind|type)s? of|how (do|can) i use|how does this (work|help)|help me|\bhelp\b|capabilities|what are you|who are you|what do you do)\b/i.test(q)) return true;
  return /^(what is|what are|explain|how does|how do|tell me (about|what|how)|describe|why (is|does|are)|what does .+? mean|define|can you explain|overview of|what.*purpose|use of)/i.test(q);
}

export function answerGeneralQuestion(question) {
  const q = question.toLowerCase();

  if (/cloudfuze|cloud fuze/.test(q)) {
    return `## CloudFuze — Cloud Migration Platform

CloudFuze is an **enterprise cloud-to-cloud migration platform** that helps organizations move data between collaboration and productivity tools.

**What CloudFuze migrates:**
- **Messaging**: Slack ↔ Microsoft Teams, Google Chat
- **Files**: Box, Dropbox, Google Drive ↔ OneDrive, SharePoint
- **Email**: Gmail ↔ Outlook/Exchange
- **Collaboration**: Workspace, channels, permissions, and metadata

**How it works:**
1. Connect your source and destination platforms via API
2. Map users between source and destination accounts
3. Run a full or incremental migration (messages, files, channels)
4. Verify data integrity with post-migration reports

**Key benefits:**
- Zero data retention after migration — your data stays yours
- Preserves timestamps, thread structure, attachments, and reactions
- Enterprise-grade security and compliance (SOC 2, GDPR)
- Real-time progress tracking through the Metabase dashboard`;
  }

  if (/collection|mongodb|mongo/.test(q)) {
    return `## MongoDB Collections in CloudFuze

In MongoDB (the database engine used by CloudFuze), a **collection** is the equivalent of a SQL table — it stores a group of related JSON documents.

**CloudFuze MongoDB Collections:**

| Collection | What it stores |
|---|---|
| **Workspaces** | Source workspaces/orgs being migrated |
| **Messages** | Chat messages from source platforms |
| **Users / Agents** | User accounts and mapping source → destination |
| **Channels** | Slack channels or Teams channels |
| **Credentials** | Encrypted API keys and OAuth tokens |
| **ActivityLogs** | Migration events and audit trail |

**Why CloudFuze uses MongoDB:**
Cloud collaboration data is hierarchical and schema-flexible — a message can have attachments, reactions, threads, and metadata. MongoDB's document model handles this far better than rigid SQL tables.

**Common queries on collections:**
- Count total documents: \`[{"$count": "total"}]\`
- Group by status: \`[{"$group": {"_id": "$status", "count": {"$sum": 1}}}]\`
- Get recent records: \`[{"$sort": {"createdAt": -1}}, {"$limit": 50}]\``;
  }

  if (/workspace/.test(q)) {
    return `## Workspaces in CloudFuze

A **workspace** represents a source collaboration environment (e.g., a Slack workspace or Microsoft Teams organization) that is being migrated to a destination platform.

**Workspace fields typically include:**

| Field | Description |
|---|---|
| name | Workspace or organization name |
| status | Migration state (pending, in_progress, completed, failed) |
| source | Origin platform (Slack, Teams, Google Workspace) |
| destination | Target platform |
| userCount | Number of users in this workspace |
| messageCount | Total messages to migrate |
| createdAt | When the migration was initiated |

**Migration status meanings:**

| Status | Meaning |
|---|---|
| **pending** | Queued, not yet started |
| **in_progress** | Actively migrating data |
| **completed** | Successfully finished |
| **failed** | Error encountered — check logs |
| **conflict** | Duplicate or mapping conflict detected |`;
  }

  if (/message|chat|msg/.test(q)) {
    return `## Messages in CloudFuze Migration

CloudFuze migrates **messages** from source platforms (Slack, Teams) to the destination, preserving all content and metadata.

**What gets migrated with each message:**
- **Content** — The text body of the message
- **Sender** — Mapped to the correct destination user via email
- **Timestamp** — Original send time is preserved exactly
- **Attachments** — Files, images, and documents linked to messages
- **Reactions** — Emoji reactions (where the destination supports it)
- **Thread replies** — Threaded conversations are maintained

**The cfqamsg database** stores message migration data for the CloudFuze QA environment, tracking which messages have been processed and their current migration state.

**Typical message fields:** \`_id\`, \`workspaceId\`, \`channelId\`, \`content\`, \`senderId\`, \`timestamp\`, \`status\`, \`attachments\``;
  }

  if (/user|member|agent/.test(q)) {
    return `## Users in CloudFuze

CloudFuze tracks **users** throughout the migration, mapping each source account to the correct destination account.

**User data stored:**
- Email address (used as the primary mapping key)
- Display name from source platform
- Source platform user ID
- Destination platform user ID
- Migration status for this user's data
- Count of messages, files owned

**Why user mapping matters:**
When a Slack message from "john@company.com" is migrated to Teams, CloudFuze needs to correctly attribute it to John's Teams account. This is done via email matching. Unmatched users are flagged for manual review.

**Typical user statuses:** mapped, unmapped, migrated, failed, skipped`;
  }

  if (/migration|migrat/.test(q)) {
    return `## Migration Process in CloudFuze

CloudFuze runs migrations in well-defined phases to ensure data integrity.

**Phase 1 — Pre-migration:**
- Connect source and destination APIs
- Enumerate all users, channels, and messages
- Build user mapping (source email → destination account)
- Estimate data volume and generate a migration plan

**Phase 2 — Migration:**
- Process messages in chronological batches
- Upload and re-link files/attachments
- Map @mentions to destination users
- Handle API rate limits automatically with exponential backoff

**Phase 3 — Post-migration:**
- Count and verify migrated vs expected records
- Flag failed items for retry
- Generate a migration report
- Optionally run a **delta sync** to catch any new content added after the initial migration

**Monitoring:** The Metabase dashboard (which this assistant is connected to) provides real-time progress tracking across all migration jobs.`;
  }

  if (/status|progress/.test(q)) {
    return `## Migration Status Values in CloudFuze

Every migration job and individual record has a **status** field tracking its current state.

| Status | Description |
|---|---|
| **pending** | Scheduled but not yet started |
| **in_progress** | Currently being migrated |
| **completed** | Successfully finished ✓ |
| **failed** | Encountered an error — will retry or needs review |
| **conflict** | Duplicate or mapping conflict detected |
| **paused** | Temporarily stopped by admin |
| **cancelled** | Manually cancelled |
| **skipped** | Excluded from migration (e.g., bot messages) |

**To check status in this system:**
- Ask "How many workspaces are in each status?"
- Ask "Show all failed workspaces"
- Ask "What is the migration progress summary?"`;
  }

  if (/channel|room/.test(q)) {
    return `## Channels in CloudFuze Migration

**Channels** (Slack) and **Teams/Channels** (Microsoft Teams) are the conversation spaces that CloudFuze migrates, along with all messages within them.

**What gets migrated for each channel:**
- Channel name, description, and purpose
- Member list (mapped to destination users)
- All messages and threads in the channel
- Pinned messages and files
- Channel metadata (created date, visibility)

**Channel types:**
- **Public channels** — Migrated by default
- **Private channels** — Require explicit permission grants from channel admins
- **DMs / Direct Messages** — Migrated as 1:1 or group DMs in the destination
- **Archived channels** — Optionally included based on configuration`;
  }

  // Default: general assistant overview
  return `## CloudFuze Metabase Intelligence

I'm connected to your Metabase instance at **metabase.cloudfuze.com** and I read your data directly from every collection. Here's what you can ask:

**Migration status & reports (for a workspace / user / job id):**
- "How much data migrated for this wsid 6a4f…?" — full breakdown: processed, not-processed, in-progress, conflict, retry, with **percentages**
- "For this userId … how much processed, conflict, in-progress?" — per-status counts + the aggregate query
- "When will the remaining data finish?" — an **ETA** based on the processing rate

**Diagnose problems:**
- "Why did it go to conflict? Give me the error description" — reads the real \`ErrorDescription\` and explains it in plain English

**Look things up:**
- "What is the process status of this <record id>?" — the exact status of one record
- "How many files / folders / messages processed?" — counts, split by type
- "Show all failed workspaces" · "List recent activity"

**Understand the data:**
- "What is the use of the MessageWorkSpace collection?" — explained from its real fields & statuses
- "What databases are available?" · "Which server has X?" · "What collections are here?"

**More:** paste screenshots for analysis, and use **Share** to send a chat to a teammate.

Just ask in plain English — I'll query the live data or explain the concept, and show you the exact MongoDB query I ran.`;
}

export function detectAndAnswerGeneral(question, schema) {
  if (!isKnowledgeQuestion(question)) return null;
  return answerGeneralQuestion(question);
}
