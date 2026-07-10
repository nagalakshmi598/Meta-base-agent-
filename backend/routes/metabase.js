import express from 'express';
import { getClientFromSession } from '../services/metabaseService.js';
import { setScanData, setCatalog, setScanProgress, getScanProgress, pickStatusFieldName } from '../services/queryService.js';

const router = express.Router();

const requireAuth = (req, res, next) => {
  if (!req.session.metabaseToken) {
    return res.status(401).json({ error: 'Not connected to Metabase' });
  }
  next();
};

router.get('/databases', requireAuth, async (req, res) => {
  try {
    const { client, token } = getClientFromSession(req.session);
    const data = await client.get(token, '/api/database', { include: 'tables' });
    res.json(data);
  } catch (err) {
    console.error('databases error:', err.message);
    res.status(err.statusCode || 500).json({ error: err.message });
  }
});

router.get('/databases/:id/metadata', requireAuth, async (req, res) => {
  try {
    const { client, token } = getClientFromSession(req.session);
    const data = await client.get(token, `/api/database/${req.params.id}/metadata`, {
      include_hidden: true
    });
    res.json(data);
  } catch (err) {
    console.error('metadata error:', err.message);
    res.status(err.statusCode || 500).json({ error: err.message });
  }
});

router.get('/tables/:id/metadata', requireAuth, async (req, res) => {
  try {
    const { client, token } = getClientFromSession(req.session);
    const data = await client.get(token, `/api/table/${req.params.id}/query_metadata`);
    res.json(data);
  } catch (err) {
    console.error('table metadata error:', err.message);
    res.status(err.statusCode || 500).json({ error: err.message });
  }
});

router.post('/dataset', requireAuth, async (req, res) => {
  const { database_id, sql } = req.body;
  if (!database_id || !sql) {
    return res.status(400).json({ error: 'database_id and sql are required' });
  }

  try {
    const { client, token } = getClientFromSession(req.session);
    const data = await client.post(token, '/api/dataset', {
      type: 'native',
      native: { query: sql, template_tags: {} },
      database: parseInt(database_id, 10)
    });

    if (data.error) {
      return res.status(400).json({ error: data.error, data });
    }

    res.json(data);
  } catch (err) {
    console.error('dataset error:', err.message);
    res.status(err.statusCode || 500).json({ error: err.message });
  }
});

router.get('/cards', requireAuth, async (req, res) => {
  try {
    const { client, token } = getClientFromSession(req.session);
    const data = await client.get(token, '/api/card', { f: 'all' });
    res.json(Array.isArray(data) ? data : data.data || []);
  } catch (err) {
    console.error('cards error:', err.message);
    res.status(err.statusCode || 500).json({ error: err.message });
  }
});

router.get('/dashboards', requireAuth, async (req, res) => {
  try {
    const { client, token } = getClientFromSession(req.session);
    const data = await client.get(token, '/api/dashboard');
    res.json(Array.isArray(data) ? data : []);
  } catch (err) {
    console.error('dashboards error:', err.message);
    res.status(err.statusCode || 500).json({ error: err.message });
  }
});

router.get('/collections', requireAuth, async (req, res) => {
  try {
    const { client, token } = getClientFromSession(req.session);
    const data = await client.get(token, '/api/collection');
    res.json(Array.isArray(data) ? data : data.data || []);
  } catch (err) {
    console.error('collections error:', err.message);
    res.status(err.statusCode || 500).json({ error: err.message });
  }
});

// ── SCAN COLLECTIONS (background training) ────────────────────────────────
// Reads sample rows from each collection (fields + real values) so routing and
// answers use real data. Scans in PARALLEL batches so even 100+ collections are
// learned quickly. Shared by /scan-database (one DB) and /scan-all-databases.
async function scanCollections(client, token, dbId, tableNames, isMongo, cacheKey, cap = 300, batchSize = 10) {
  const tableList = (tableNames || []).slice(0, cap);
  let scanned = 0;
  for (let i = 0; i < tableList.length; i += batchSize) {
    const batch = tableList.slice(i, i + batchSize);
    const results = await Promise.all(batch.map(async (tableName) => {
      try {
        const sampleQuery = isMongo
          ? { query: JSON.stringify([{ '$limit': 5 }]), collection: tableName, template_tags: {} }
          : { query: `SELECT * FROM "${tableName}" LIMIT 5`, template_tags: {} };
        // The TRUE document count — read in PARALLEL with the sample so the agent
        // knows each collection's real volume (a 6-doc side-table vs a 96,000-doc
        // main table). Runs concurrently, so it adds little wall-clock. If the
        // count times out we still keep the sample (docCount just stays unknown).
        const countQuery = isMongo
          ? { query: JSON.stringify([{ '$count': 'n' }]), collection: tableName, template_tags: {} }
          : { query: `SELECT COUNT(*) AS n FROM "${tableName}"`, template_tags: {} };
        const [result, countRes] = await Promise.all([
          client.post(token, '/api/dataset', { type: 'native', native: sampleQuery, database: dbId }),
          client.post(token, '/api/dataset', { type: 'native', native: countQuery, database: dbId }).catch(() => null),
        ]);
        if (!result.error && result.data?.rows?.length > 0) {
          const cols = (result.data.cols || []).map(c => c.name);
          const rows = result.data.rows;
          const sampleValues = {};
          cols.forEach((col, idx) => {
            sampleValues[col] = rows
              .map(r => String(r[idx] ?? ''))
              .filter(v => v && v !== 'null' && v !== 'NULL' && v !== 'undefined' && v.length < 300);
          });
          // Extract the real count (single scalar cell). undefined if it failed.
          let docCount;
          const cv = countRes && !countRes.error ? countRes.data?.rows?.[0]?.[0] : undefined;
          if (typeof cv === 'number') docCount = cv;
          else if (cv != null && /^\d+$/.test(String(cv))) docCount = parseInt(cv, 10);

          // DEEP READ: capture the collection's REAL status vocabulary. From 5
          // sample rows the agent can't see every status a collection uses, so it
          // would fall back to a guessed regex ("process|complet|…") and miscount.
          // Here we detect the actual status field and GROUP the whole collection
          // by it — giving ground-truth distinct values + per-status counts. This
          // is what lets "processed / conflict / not migrated" map to the exact
          // value each collection really stores. One extra grouped query per
          // collection, run in the background scan only.
          const statusField = pickStatusFieldName(cols);
          let statusValues; // [{ value, count }] sorted desc
          if (statusField) {
            try {
              const groupQuery = isMongo
                ? { query: JSON.stringify([
                      { '$group': { '_id': `$${statusField}`, 'n': { '$sum': 1 } } },
                      { '$sort': { 'n': -1 } }, { '$limit': 50 }
                    ]), collection: tableName, template_tags: {} }
                : { query: `SELECT "${statusField}" AS v, COUNT(*) AS n FROM "${tableName}" GROUP BY "${statusField}" ORDER BY n DESC LIMIT 50`, template_tags: {} };
              const gRes = await client.post(token, '/api/dataset', { type: 'native', native: groupQuery, database: dbId }).catch(() => null);
              if (gRes && !gRes.error && gRes.data?.rows?.length) {
                statusValues = gRes.data.rows
                  .map(r => ({ value: r[0], count: Number(r[1]) || 0 }))
                  .filter(sv => sv.value != null && String(sv.value).trim() !== '');
              }
            } catch (e) { /* status grouping is best-effort — keep the rest */ }
          }

          setScanData(cacheKey, tableName, { cols, sampleValues, rowCount: rows.length, docCount, statusField, statusValues });
          return 1;
        }
      } catch (e) { /* transient Mongo timeout/error → skip, keep going */ }
      return 0;
    }));
    scanned += results.reduce((a, b) => a + b, 0);
  }
  return { scanned, total: tableList.length };
}

// Scan EVERY collection in ONE database (the selected one) — fully, in parallel.
router.post('/scan-database', requireAuth, async (req, res) => {
  const { database_id, tables, engine } = req.body;
  if (!database_id || !Array.isArray(tables) || !tables.length) {
    return res.status(400).json({ error: 'database_id and tables[] required' });
  }
  const { client, token } = getClientFromSession(req.session);
  const isMongo = (engine || '').toLowerCase().includes('mongo');
  const dbId = parseInt(database_id, 10);
  const cacheKey = `${req.session.id}:${database_id}`;
  console.log(`[Scan] Scanning ALL ${tables.length} collections for db=${database_id}`);
  const { scanned, total } = await scanCollections(client, token, dbId, tables, isMongo, cacheKey, 500);
  console.log(`[Scan] Complete: ${scanned}/${total} collections learned (db=${database_id})`);
  res.json({ scanned, total });
});

// Deep-scan EVERY collection in EVERY database (all servers) — runs in the
// BACKGROUND (returns immediately) and reports progress via /scan-all-status.
// Time-boxed; per-DB cap high enough to cover full servers, parallel batches.
const SCAN_ALL_DEADLINE_MS = 12 * 60 * 1000; // stop after ~12 minutes
const SCAN_ALL_COLLS_PER_DB = 150;

router.post('/scan-all-databases', requireAuth, async (req, res) => {
  const { client, token } = getClientFromSession(req.session);
  const sessionId = req.session.id;

  const existing = getScanProgress(sessionId);
  if (existing.status === 'scanning') {
    return res.json({ started: false, alreadyRunning: true, ...existing });
  }

  let dbList;
  try {
    const dbsResp = await client.get(token, '/api/database', { include: 'tables' });
    dbList = (Array.isArray(dbsResp) ? dbsResp : dbsResp.data || []).filter(d => !d.is_sample);
  } catch (err) {
    return res.status(err.statusCode || 500).json({ error: err.message });
  }

  // Cache the catalog (all servers + their collections) up front — this is the
  // fast, reliable cross-server knowledge and doesn't need the Mongo data layer.
  setCatalog(sessionId, dbList.map(d => ({
    id: d.id, name: d.name, engine: d.engine, collections: (d.tables || []).map(t => t.name)
  })));

  setScanProgress(sessionId, { status: 'scanning', dbTotal: dbList.length, dbDone: 0, collectionsScanned: 0, currentDb: '', startedAt: Date.now() });
  res.json({ started: true, databases: dbList.length });

  // ── Background loop (NOT awaited) — the response is already sent ──────────
  (async () => {
    const deadline = Date.now() + SCAN_ALL_DEADLINE_MS;
    let dbDone = 0, collectionsScanned = 0;
    for (const db of dbList) {
      if (Date.now() > deadline) { console.log('[ScanAll] time budget reached — stopping'); break; }
      const isMongo = (db.engine || '').toLowerCase().includes('mongo');
      const tableNames = (db.tables || []).map(t => t.name);
      const cacheKey = `${sessionId}:${db.id}`;
      try {
        const { scanned } = await scanCollections(client, token, db.id, tableNames, isMongo, cacheKey, SCAN_ALL_COLLS_PER_DB);
        collectionsScanned += scanned;
      } catch (e) { /* skip this DB, keep going */ }
      dbDone++;
      setScanProgress(sessionId, { status: 'scanning', dbTotal: dbList.length, dbDone, collectionsScanned, currentDb: db.name, startedAt: existing.startedAt || Date.now() });
    }
    setScanProgress(sessionId, { status: 'done', dbTotal: dbList.length, dbDone, collectionsScanned });
    console.log(`[ScanAll] DONE — ${collectionsScanned} collections across ${dbDone}/${dbList.length} databases`);
  })().catch(e => { console.error('[ScanAll] background error:', e.message); setScanProgress(sessionId, { status: 'error', error: e.message }); });
});

// Poll the background deep-scan progress.
router.get('/scan-all-status', requireAuth, (req, res) => {
  res.json(getScanProgress(req.session.id));
});

export default router;
