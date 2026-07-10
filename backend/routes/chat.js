// ── CHAT SAVE / SHARE / DELETE ─────────────────────────────────────────────
// Lets a signed-in user save a conversation, share it (by link or by Metabase
// email), open chats shared with them, and delete their own chats.
import express from 'express';
import {
  saveChat, getChatById, getChatByToken, listChatsForUser,
  createShareLink, revokeShareLink, shareWithEmails, unshareEmail,
  deleteChat, canAccess, summarize
} from '../services/chatStore.js';

const router = express.Router();

const requireAuth = (req, res, next) => {
  if (!req.session.metabaseToken) {
    return res.status(401).json({ error: 'Session expired. Please reconnect to Metabase.', reconnect: true });
  }
  next();
};

const currentEmail = req => req.session.metabaseEmail || req.session.id;

// Base URL the frontend is served from — used to build share links.
function frontendBase(req) {
  return (process.env.FRONTEND_URL || req.headers.origin || 'http://localhost:5173').replace(/\/$/, '');
}
const linkFor = (req, token) => `${frontendBase(req)}/?shared=${token}`;

// Save (create or update) a chat the caller owns.
router.post('/save', requireAuth, (req, res) => {
  const { id, title, messages } = req.body || {};
  try {
    const chat = saveChat(currentEmail(req), { id, title, messages });
    res.json({ id: chat.id, title: chat.title, updatedAt: chat.updatedAt, owner: chat.ownerEmail });
  } catch (err) {
    res.status(err.statusCode || 500).json({ error: err.message });
  }
});

// List my chats + chats shared with me.
router.get('/list', requireAuth, (req, res) => {
  res.json({ chats: listChatsForUser(currentEmail(req)), me: currentEmail(req) });
});

// Open a chat by id (must be owner / shared-with / hold the link token).
router.get('/:id', requireAuth, (req, res) => {
  const chat = getChatById(req.params.id);
  if (!chat) return res.status(404).json({ error: 'Chat not found.' });
  if (!canAccess(chat, currentEmail(req), req.query.token)) {
    return res.status(403).json({ error: 'You do not have access to this chat.' });
  }
  res.json({ chat: { ...summarize(chat, currentEmail(req)), messages: chat.messages || [] } });
});

// Open a shared chat via its link token.
router.get('/shared/:token', requireAuth, (req, res) => {
  const chat = getChatByToken(req.params.token);
  if (!chat) return res.status(404).json({ error: 'This shared link is invalid or has been revoked.' });
  res.json({ chat: { ...summarize(chat, currentEmail(req)), messages: chat.messages || [], readOnly: true } });
});

// Create/reuse a share link. Returns the full share URL + token.
router.post('/:id/share-link', requireAuth, (req, res) => {
  try {
    const token = createShareLink(req.params.id, currentEmail(req));
    res.json({ token, url: linkFor(req, token) });
  } catch (err) {
    res.status(err.statusCode || 500).json({ error: err.message });
  }
});

// Revoke the share link.
router.post('/:id/revoke-link', requireAuth, (req, res) => {
  try {
    revokeShareLink(req.params.id, currentEmail(req));
    res.json({ ok: true });
  } catch (err) {
    res.status(err.statusCode || 500).json({ error: err.message });
  }
});

// Share with specific Metabase emails. Also returns a link for convenience.
router.post('/:id/share-emails', requireAuth, (req, res) => {
  try {
    const emails = Array.isArray(req.body?.emails) ? req.body.emails : [];
    const sharedWith = shareWithEmails(req.params.id, currentEmail(req), emails);
    const token = createShareLink(req.params.id, currentEmail(req)); // so recipients also get a link
    res.json({ sharedWith, token, url: linkFor(req, token) });
  } catch (err) {
    res.status(err.statusCode || 500).json({ error: err.message });
  }
});

// Remove one email's access.
router.post('/:id/unshare-email', requireAuth, (req, res) => {
  try {
    const sharedWith = unshareEmail(req.params.id, currentEmail(req), (req.body?.email || '').trim());
    res.json({ sharedWith });
  } catch (err) {
    res.status(err.statusCode || 500).json({ error: err.message });
  }
});

// Delete a chat (owner only).
router.delete('/:id', requireAuth, (req, res) => {
  try {
    const ok = deleteChat(req.params.id, currentEmail(req));
    res.json({ deleted: ok });
  } catch (err) {
    res.status(err.statusCode || 500).json({ error: err.message });
  }
});

export default router;
