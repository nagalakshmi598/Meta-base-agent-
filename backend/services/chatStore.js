// ── CHAT PERSISTENCE + SHARING ─────────────────────────────────────────────
// File-backed store for saved chats and their share settings. A chat is owned
// by the Metabase email that created it, and can be shared two ways:
//   • by LINK  — a random token; anyone signed in who opens the link can view;
//   • by EMAIL — specific Metabase emails; the chat then appears in each of
//     those users' "Shared with me" list when they sign in.
// No database needed — this is a small JSON file (data/chats.json), mirroring
// how the query log persists. All writes are write-through to disk.
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, '..', 'data');
const STORE_FILE = path.join(DATA_DIR, 'chats.json');

let _store = null; // { chats: { [id]: chat } }

function load() {
  if (_store) return _store;
  try {
    _store = JSON.parse(fs.readFileSync(STORE_FILE, 'utf8'));
    if (!_store || typeof _store !== 'object' || !_store.chats) _store = { chats: {} };
  } catch {
    _store = { chats: {} };
  }
  return _store;
}

function persist() {
  try {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(STORE_FILE, JSON.stringify(_store, null, 2), 'utf8');
  } catch (e) {
    console.error('[ChatStore] write failed:', e.message);
  }
}

const norm = e => (e || '').trim().toLowerCase();

// Can this viewer see the chat? Owner, an email it's shared with, or the link token.
export function canAccess(chat, email, token) {
  if (!chat) return false;
  const e = norm(email);
  if (e && norm(chat.ownerEmail) === e) return true;
  if (e && (chat.sharedWith || []).some(x => norm(x) === e)) return true;
  if (token && chat.shareToken && token === chat.shareToken) return true;
  return false;
}

// A compact list-item view (no messages) with the viewer's relationship to it.
function summarize(chat, viewerEmail) {
  const e = norm(viewerEmail);
  return {
    id: chat.id,
    title: chat.title || 'Untitled chat',
    updatedAt: chat.updatedAt,
    createdAt: chat.createdAt,
    owner: chat.ownerEmail,
    mine: norm(chat.ownerEmail) === e,
    messageCount: (chat.messages || []).length,
    sharedWith: chat.sharedWith || [],
    hasLink: !!chat.shareToken,
  };
}

// Create a new chat or update an existing one the caller OWNS. Returns the chat.
export function saveChat(ownerEmail, { id, title, messages }) {
  const s = load();
  const now = new Date().toISOString();
  let chat = id ? s.chats[id] : null;

  if (chat) {
    // Only the owner may overwrite an existing chat's content.
    if (norm(chat.ownerEmail) !== norm(ownerEmail)) {
      const err = new Error('You can only edit chats you own.');
      err.statusCode = 403;
      throw err;
    }
    if (Array.isArray(messages)) chat.messages = messages;
    if (title) chat.title = title;
    chat.updatedAt = now;
  } else {
    chat = {
      id: crypto.randomUUID(),
      ownerEmail: (ownerEmail || '').trim(),
      title: title || 'Untitled chat',
      messages: Array.isArray(messages) ? messages : [],
      shareToken: null,
      sharedWith: [],
      createdAt: now,
      updatedAt: now,
    };
    s.chats[chat.id] = chat;
  }
  persist();
  return chat;
}

export function getChatById(id) {
  return load().chats[id] || null;
}

export function getChatByToken(token) {
  if (!token) return null;
  return Object.values(load().chats).find(c => c.shareToken === token) || null;
}

// Chats the user owns + chats shared with their email (most recent first).
export function listChatsForUser(email) {
  const e = norm(email);
  return Object.values(load().chats)
    .filter(c => norm(c.ownerEmail) === e || (c.sharedWith || []).some(x => norm(x) === e))
    .sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''))
    .map(c => summarize(c, email));
}

// Generate (or reuse) a share link token for a chat the caller owns.
export function createShareLink(id, ownerEmail) {
  const chat = getChatById(id);
  if (!chat) { const e = new Error('Chat not found.'); e.statusCode = 404; throw e; }
  if (norm(chat.ownerEmail) !== norm(ownerEmail)) { const e = new Error('Only the owner can share this chat.'); e.statusCode = 403; throw e; }
  if (!chat.shareToken) { chat.shareToken = crypto.randomBytes(18).toString('hex'); chat.updatedAt = new Date().toISOString(); persist(); }
  return chat.shareToken;
}

// Revoke the share link (existing links stop working).
export function revokeShareLink(id, ownerEmail) {
  const chat = getChatById(id);
  if (!chat) { const e = new Error('Chat not found.'); e.statusCode = 404; throw e; }
  if (norm(chat.ownerEmail) !== norm(ownerEmail)) { const e = new Error('Only the owner can change sharing.'); e.statusCode = 403; throw e; }
  chat.shareToken = null; chat.updatedAt = new Date().toISOString(); persist();
}

// Grant specific emails access. Returns the updated sharedWith list.
export function shareWithEmails(id, ownerEmail, emails) {
  const chat = getChatById(id);
  if (!chat) { const e = new Error('Chat not found.'); e.statusCode = 404; throw e; }
  if (norm(chat.ownerEmail) !== norm(ownerEmail)) { const e = new Error('Only the owner can share this chat.'); e.statusCode = 403; throw e; }
  const clean = (Array.isArray(emails) ? emails : [])
    .map(x => (x || '').trim())
    .filter(x => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(x));
  const set = new Set((chat.sharedWith || []).map(norm));
  for (const em of clean) if (norm(em) !== norm(ownerEmail)) set.add(em); // store as given, dedupe by lowercase
  // Preserve original casing where possible: rebuild from clean + existing
  const merged = [];
  const seen = new Set();
  for (const em of [...(chat.sharedWith || []), ...clean]) {
    const k = norm(em);
    if (k && k !== norm(ownerEmail) && !seen.has(k)) { seen.add(k); merged.push(em.trim()); }
  }
  chat.sharedWith = merged;
  chat.updatedAt = new Date().toISOString();
  persist();
  return chat.sharedWith;
}

// Remove one email's access.
export function unshareEmail(id, ownerEmail, email) {
  const chat = getChatById(id);
  if (!chat) { const e = new Error('Chat not found.'); e.statusCode = 404; throw e; }
  if (norm(chat.ownerEmail) !== norm(ownerEmail)) { const e = new Error('Only the owner can change sharing.'); e.statusCode = 403; throw e; }
  chat.sharedWith = (chat.sharedWith || []).filter(x => norm(x) !== norm(email));
  chat.updatedAt = new Date().toISOString();
  persist();
  return chat.sharedWith;
}

// Delete a chat (owner only).
export function deleteChat(id, ownerEmail) {
  const s = load();
  const chat = s.chats[id];
  if (!chat) return false;
  if (norm(chat.ownerEmail) !== norm(ownerEmail)) { const e = new Error('Only the owner can delete this chat.'); e.statusCode = 403; throw e; }
  delete s.chats[id];
  persist();
  return true;
}

export { summarize };
