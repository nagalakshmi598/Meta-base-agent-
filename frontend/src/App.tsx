import { useState, useEffect, useCallback } from 'react';
import { authApi, metabaseApi, aiApi, chatApi, setSessionExpiredHandler } from './services/api';
import type { Database, Schema, Message, ConnectionState } from './types';
import ConnectModal from './components/ConnectModal';
import Sidebar from './components/Sidebar';
import ChatInterface from './components/ChatInterface';
import ShareModal from './components/ShareModal';
import ChatsModal from './components/ChatsModal';

// Rehydrate stored messages (timestamps come back as strings from JSON).
function hydrate(msgs: any[]): Message[] {
  return (msgs || []).map(m => ({ ...m, timestamp: new Date(m.timestamp || Date.now()) }));
}
// A short chat title from the first user question.
function deriveTitle(msgs: Message[]): string {
  const first = msgs.find(m => m.role === 'user' && m.content);
  return (first?.content || 'Untitled chat').slice(0, 60);
}

export default function App() {
  const [connection, setConnection] = useState<ConnectionState>({
    connected: false,
    url: null,
    connectedAt: null
  });
  const [showConnect, setShowConnect] = useState(true);   // open immediately
  const [backendDown, setBackendDown] = useState(false);
  const [databases, setDatabases] = useState<Database[]>([]);
  const [selectedDb, setSelectedDb] = useState<Database | null>(null);
  const [schema, setSchema] = useState<Schema | null>(null);
  const [schemaLoading, setSchemaLoading] = useState(false);
  const [messages, setMessages] = useState<Message[]>([]);
  const [suggestions, setSuggestions] = useState<string[]>([]);
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [aiEnabled, setAiEnabled] = useState(false);
  const [scanStatus, setScanStatus] = useState<'idle' | 'scanning' | 'ready'>('idle');
  const [scanCount, setScanCount] = useState(0);
  const [questionToFill, setQuestionToFill] = useState('');

  // Chat persistence + sharing
  const [currentChatId, setCurrentChatId] = useState<string | null>(null);
  const [showShare, setShowShare] = useState(false);
  const [showChats, setShowChats] = useState(false);
  const [chatReadOnly, setChatReadOnly] = useState(false);   // viewing someone else's shared chat
  const [chatOwner, setChatOwner] = useState<string>('');
  const [pendingSharedToken, setPendingSharedToken] = useState<string | null>(null);

  // NOTE: We intentionally do NOT scan all servers. Collections are read per
  // SELECTED server (see handleSelectDatabase) — switching servers reads that
  // server's collections. This keeps Metabase responsive and answers fast.

  // Register session-expiry handler so any 401 auto-opens connect modal
  useEffect(() => {
    setSessionExpiredHandler(() => {
      setConnection({ connected: false, url: null, connectedAt: null });
      setShowConnect(true);
    });
  }, []);

  // On mount: restore an existing session if the user is already signed in;
  // otherwise show the sign-in modal. Every user logs in with THEIR OWN Metabase
  // account — no shared/auto credentials.
  useEffect(() => {
    Promise.all([
      authApi.status(),
      aiApi.config().catch(() => ({ ai_enabled: false, mode: 'sql' as const, message: '' }))
    ]).then(([status, config]) => {
      setAiEnabled(config.ai_enabled);
      setBackendDown(false);
      if (status.connected) {
        setConnection(status);
        setShowConnect(false);
        loadDatabases();
      }
      // else: showConnect stays true → the sign-in modal is displayed
    }).catch(() => {
      setBackendDown(true);
    });
  }, []);

  const loadDatabases = useCallback(async () => {
    try {
      const data = await metabaseApi.getDatabases();
      const dbs = Array.isArray(data) ? data : (data as any).data || [];
      setDatabases(dbs.filter((d: Database) => !d.is_sample));
    } catch {
      setDatabases([]);
    }
  }, []);

  const handleConnect = async (url: string, email: string, password: string) => {
    await authApi.connect(url, email, password);
    const [status, config] = await Promise.all([
      authApi.status(),
      aiApi.config().catch(() => ({ ai_enabled: false, mode: 'sql' as const, message: '' }))
    ]);
    setConnection(status);
    setAiEnabled(config.ai_enabled);
    setBackendDown(false);
    setShowConnect(false);
    await loadDatabases();
  };

  const handleDisconnect = async () => {
    await authApi.disconnect();
    setConnection({ connected: false, url: null, connectedAt: null });
    setDatabases([]);
    setSelectedDb(null);
    setSchema(null);
    setMessages([]);
    setSuggestions([]);
    setCurrentChatId(null);
    setChatReadOnly(false);
    setChatOwner('');
    setShowConnect(true);
  };

  const handleSelectDatabase = async (db: Database) => {
    setSelectedDb(db);
    setSchema(null);
    setMessages([]);
    setSuggestions([]);
    setCurrentChatId(null);
    setChatReadOnly(false);
    setChatOwner('');
    setScanStatus('idle');
    setScanCount(0);
    setSchemaLoading(true);
    try {
      const meta = await metabaseApi.getDatabaseMetadata(db.id);
      setSchema(meta);

      // Background scan — reads sample data from every collection to improve routing
      const tableNames = (meta.tables || []).map((t: any) => t.name);
      if (tableNames.length > 0) {
        setScanStatus('scanning');
        metabaseApi.scanDatabase(db.id, tableNames, meta.engine || '')
          .then(result => {
            setScanCount(result.scanned);
            setScanStatus('ready');
            console.log(`[Scan] Learned ${result.scanned}/${result.total} collections`);
          })
          .catch(() => setScanStatus('idle'));
      }
    } catch (err: any) {
      console.error('Schema load failed:', err.message);
    } finally {
      setSchemaLoading(false);
    }
  };

  const addMessage = useCallback((msg: Message) => {
    setMessages(prev => [...prev, msg]);
  }, []);

  const updateMessage = useCallback((id: string, updates: Partial<Message>) => {
    setMessages(prev => prev.map(m => m.id === id ? { ...m, ...updates } : m));
  }, []);

  // Remove the message with this id and everything after it (used when a user
  // edits & resends a question — the old answer and later turns are discarded).
  const truncateFrom = useCallback((id: string) => {
    setMessages(prev => {
      const i = prev.findIndex(m => m.id === id);
      return i === -1 ? prev : prev.slice(0, i);
    });
  }, []);

  // ── CHAT SAVE / SHARE / DELETE ──────────────────────────────────────────
  // Persist the current conversation and return its id (used before sharing).
  const ensureChatSaved = useCallback(async (): Promise<string> => {
    const res = await chatApi.save({ id: currentChatId || undefined, title: deriveTitle(messages), messages });
    setCurrentChatId(res.id);
    return res.id;
  }, [currentChatId, messages]);

  // Auto-save my own conversations (not shared read-only views) so they appear
  // in "Your chats". Debounced; reuses the same chat id once created.
  useEffect(() => {
    if (chatReadOnly) return;
    const done = messages.length > 0 && !messages[messages.length - 1]?.loading;
    const hasAssistant = messages.some(m => m.role === 'assistant');
    if (!done || !hasAssistant) return;
    const t = setTimeout(() => {
      chatApi.save({ id: currentChatId || undefined, title: deriveTitle(messages), messages })
        .then(res => { if (!currentChatId) setCurrentChatId(res.id); })
        .catch(() => { /* saving is best-effort */ });
    }, 1200);
    return () => clearTimeout(t);
  }, [messages, currentChatId, chatReadOnly]);

  const handleDeleteChat = useCallback(async () => {
    if (!window.confirm('Delete this chat? This removes it for everyone it was shared with and cannot be undone.')) return;
    try { if (currentChatId) await chatApi.del(currentChatId); } catch { /* ignore */ }
    setMessages([]);
    setSuggestions([]);
    setCurrentChatId(null);
    setChatReadOnly(false);
    setChatOwner('');
  }, [currentChatId]);

  // Load a chat (mine or shared with me) into the main view.
  const handleOpenChat = useCallback(async (id: string) => {
    try {
      const { chat } = await chatApi.get(id);
      setMessages(hydrate(chat.messages));
      setCurrentChatId(chat.mine ? chat.id : null);   // only owner edits in place
      setChatReadOnly(!chat.mine);
      setChatOwner(chat.owner || '');
      setShowChats(false);
      setSuggestions([]);
    } catch (e) {
      console.error('Open chat failed:', e);
    }
  }, []);

  // On first load, capture a ?shared=<token> link so we can open it after sign-in.
  useEffect(() => {
    try {
      const t = new URLSearchParams(window.location.search).get('shared');
      if (t) setPendingSharedToken(t);
    } catch { /* ignore */ }
  }, []);

  // Once connected, open any pending shared-link chat (read-only if not ours).
  useEffect(() => {
    if (!connection.connected || !pendingSharedToken) return;
    chatApi.getShared(pendingSharedToken)
      .then(({ chat }) => {
        setMessages(hydrate(chat.messages));
        setChatReadOnly(!chat.mine);
        setChatOwner(chat.owner || '');
        setCurrentChatId(chat.mine ? chat.id : null);
      })
      .catch(err => console.warn('Shared chat load failed:', err.message))
      .finally(() => {
        setPendingSharedToken(null);
        try { window.history.replaceState({}, '', window.location.pathname); } catch { /* ignore */ }
      });
  }, [connection.connected, pendingSharedToken]);

  return (
    <div style={{ display: 'flex', height: '100vh', background: '#ffffff', overflow: 'hidden' }}>

      {/* Connect modal — rendered at top level using fixed positioning */}
      {showConnect && (
        <ConnectModal
          onConnect={handleConnect}
          onClose={connection.connected ? () => setShowConnect(false) : undefined}
        />
      )}

      {connection.connected && (
        <Sidebar
          open={sidebarOpen}
          connection={connection}
          databases={databases}
          selectedDb={selectedDb}
          schema={schema}
          schemaLoading={schemaLoading}
          suggestions={suggestions}
          aiEnabled={aiEnabled}
          scanStatus={scanStatus}
          scanCount={scanCount}
          onSelectDatabase={handleSelectDatabase}
          onDisconnect={handleDisconnect}
          onShowConnect={() => setShowConnect(true)}
          onToggle={() => setSidebarOpen(o => !o)}
          onUseSuggestion={(q) => setQuestionToFill(q)}
        />
      )}

      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minWidth: 0 }}>
        {connection.connected ? (
          <ChatInterface
            selectedDb={selectedDb}
            schema={schema}
            messages={messages}
            suggestions={suggestions}
            sidebarOpen={sidebarOpen}
            aiEnabled={aiEnabled}
            questionToFill={questionToFill}
            onQuestionFilled={() => setQuestionToFill('')}
            onToggleSidebar={() => setSidebarOpen(o => !o)}
            onAddMessage={addMessage}
            onUpdateMessage={updateMessage}
            onTruncateFrom={truncateFrom}
            onSuggestionsReady={setSuggestions}
            onOpenShare={() => setShowShare(true)}
            onOpenChats={() => setShowChats(true)}
            onDeleteChat={handleDeleteChat}
            readOnly={chatReadOnly}
            sharedByLabel={chatOwner}
          />
        ) : (
          /* Fallback: visible button to open modal if it ever fails to show */
          <div style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 16 }}>
            {backendDown && (
              <div style={{ background: '#fef2f2', border: '1px solid #fecaca', borderRadius: 10, padding: '12px 20px', color: '#dc2626', fontSize: 13, maxWidth: 400, textAlign: 'center' }}>
                ⚠️ Backend server is not running.<br />
                Start it with: <code style={{ background: '#f1f5f9', padding: '2px 6px', borderRadius: 4 }}>cd backend && npm run dev</code>
              </div>
            )}
            <div style={{ textAlign: 'center' }}>
              <div style={{ fontSize: 48, marginBottom: 12 }}>🔌</div>
              <p style={{ color: '#64748b', fontSize: 14, marginBottom: 16 }}>Connect to Metabase to get started</p>
              <button
                onClick={() => setShowConnect(true)}
                style={{
                  background: '#0129ac', border: 'none', borderRadius: 8,
                  padding: '10px 24px', color: 'white', fontSize: 14,
                  fontWeight: 500, cursor: 'pointer'
                }}
              >
                Open Connect Dialog
              </button>
            </div>
          </div>
        )}
      </div>

      {/* Share this chat (link / email / Teams) */}
      {showShare && (
        <ShareModal ensureSaved={ensureChatSaved} onClose={() => setShowShare(false)} />
      )}

      {/* Your chats + chats shared with you */}
      {showChats && (
        <ChatsModal onOpen={handleOpenChat} onClose={() => setShowChats(false)} />
      )}
    </div>
  );
}
