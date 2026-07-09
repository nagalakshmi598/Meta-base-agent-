import express from 'express';
import { createMetabaseClient } from '../services/metabaseService.js';

const router = express.Router();

// Read Metabase login credentials from environment (.env)
function getEnvCredentials() {
  const url      = (process.env.METABASE_URL || '').trim();
  const email    = (process.env.METABASE_EMAIL || '').trim();
  const password = (process.env.METABASE_PASSWORD || '').trim();
  return { url, email, password, configured: !!(url && email && password) };
}

// Shared: authenticate against Metabase and store the session. Returns a
// { ok, status, error } result instead of touching res, so callers decide the response.
async function connectAndStore(req, { url, email, password }) {
  let normalizedUrl = (url || '').trim();
  if (!normalizedUrl.startsWith('http')) normalizedUrl = `https://${normalizedUrl}`;
  normalizedUrl = normalizedUrl.replace(/\/$/, '');

  const tryAuth = async () => {
    const client = createMetabaseClient(normalizedUrl);
    return client.authenticate(email, password);
  };

  let sessionToken;
  try {
    sessionToken = await tryAuth();
  } catch (firstErr) {
    const st = firstErr.response?.status;
    // Auto-retry once for transient 5xx errors (502 = server momentarily unavailable)
    if (st >= 500) {
      console.warn(`[Auth] Got ${st} from Metabase — retrying in 2s...`);
      await new Promise(r => setTimeout(r, 2000));
      sessionToken = await tryAuth(); // throws again if still failing
    } else {
      throw firstErr;
    }
  }

  req.session.metabaseUrl = normalizedUrl;
  req.session.metabaseToken = sessionToken;
  req.session.metabaseEmail = email;              // for the query audit log
  req.session.connectedAt = new Date().toISOString();
  return normalizedUrl;
}

// Map a caught auth error to an { status, error } response payload
function authErrorResponse(err, normalizedUrl) {
  const status = err.response?.status;
  if (status === 401 || status === 403) {
    return { status: 401, error: 'Invalid email or password. Please check your credentials.' };
  }
  if (status === 404) {
    return { status: 400, error: `Metabase API not found at ${normalizedUrl}. Make sure the URL is correct.` };
  }
  if (status >= 500) {
    return { status: 502, error: `The Metabase server at ${normalizedUrl} is currently unavailable (HTTP ${status} — Bad Gateway). The server may be restarting. Please wait a moment and try again.` };
  }
  if (err.code === 'ENOTFOUND' || err.code === 'EAI_AGAIN') {
    return { status: 400, error: `Cannot resolve "${normalizedUrl}". If this is an internal company address, connect to your corporate VPN (e.g. OpenVPN) and try again. Otherwise, check the URL for typos.` };
  }
  if (err.code === 'ECONNREFUSED') {
    return { status: 400, error: `Connection refused at ${normalizedUrl}. Metabase may not be running.` };
  }
  if (err.code === 'ETIMEDOUT' || err.code === 'ECONNRESET') {
    return { status: 400, error: `Connection to ${normalizedUrl} timed out. The server may be slow or unreachable.` };
  }
  if (err.message?.toLowerCase().includes('certificate') || err.code?.includes('CERT')) {
    return { status: 400, error: `SSL certificate error for ${normalizedUrl}. The server's certificate may be expired or invalid.` };
  }
  return { status: 500, error: err.message || 'Connection failed. Please try again.' };
}

// Sign in — MULTI-USER. Every user authenticates with THEIR OWN Metabase email
// + password. Only the Metabase URL may default to the shared instance (from
// .env) for convenience; email/password must be provided by the user and are
// verified directly against Metabase (never falls back to a stored password).
router.post('/connect', async (req, res) => {
  const env = getEnvCredentials();
  const url      = (req.body.url || env.url || '').trim();
  const email    = (req.body.email || '').trim();
  const password = req.body.password || '';

  if (!url || !email || !password) {
    return res.status(400).json({ error: 'Metabase URL, email, and password are required' });
  }

  const normalizedUrl = url.startsWith('http') ? url.replace(/\/$/, '') : `https://${url.replace(/\/$/, '')}`;
  try {
    const finalUrl = await connectAndStore(req, { url, email, password });
    res.json({ success: true, message: 'Connected to Metabase successfully', url: finalUrl });
  } catch (err) {
    console.error('Auth error:', err.message);
    const { status, error } = authErrorResponse(err, normalizedUrl);
    res.status(status).json({ error });
  }
});

// Auto-connect — uses ONLY the credentials stored in .env. The frontend calls
// this on startup so a fully-configured .env skips the login popup entirely.
router.post('/auto-connect', async (req, res) => {
  const env = getEnvCredentials();
  if (!env.configured) {
    return res.status(400).json({ error: 'No Metabase credentials configured in .env', configured: false });
  }
  try {
    const finalUrl = await connectAndStore(req, env);
    console.log(`[Auth] Auto-connected to ${finalUrl} using .env credentials`);
    res.json({ success: true, message: 'Auto-connected using .env credentials', url: finalUrl });
  } catch (err) {
    console.error('Auto-connect error:', err.message);
    const { status, error } = authErrorResponse(err, env.url);
    res.status(status).json({ error });
  }
});

// Tells the frontend whether auto-login is available (never exposes the password)
router.get('/env-status', (req, res) => {
  const env = getEnvCredentials();
  res.json({
    configured: env.configured,
    url: env.url || null,
    email: env.email || null
  });
});

router.post('/disconnect', (req, res) => {
  req.session.destroy(err => {
    if (err) return res.status(500).json({ error: 'Failed to disconnect' });
    res.json({ success: true, message: 'Disconnected successfully' });
  });
});

router.get('/status', (req, res) => {
  res.json({
    connected: !!(req.session.metabaseToken),
    url: req.session.metabaseUrl || null,
    connectedAt: req.session.connectedAt || null
  });
});

export default router;
