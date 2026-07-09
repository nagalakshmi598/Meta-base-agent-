import { useState, useEffect, useCallback } from 'react';
import { authApi, metabaseApi, aiApi, setSessionExpiredHandler } from './services/api';
import type { Database, Schema, Message, ConnectionState } from './types';
import ConnectModal from './components/ConnectModal';
import Sidebar from './components/Sidebar';
import ChatInterface from './components/ChatInterface';

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
  const [deepScanStatus, setDeepScanStatus] = useState<'idle' | 'scanning' | 'done'>('idle');
  const [deepScanInfo, setDeepScanInfo] = useState('');

  const handleScanAll = useCallback(async () => {
    setDeepScanStatus('scanning');
    setDeepScanInfo('');
    try {
      await metabaseApi.scanAllDatabases(); // returns immediately; runs in background
      // Poll progress every 4s until done
      const poll = async () => {
        try {
          const s = await metabaseApi.scanAllStatus();
          if (s.status === 'scanning') {
            setDeepScanInfo(`Scanning ${s.dbDone}/${s.dbTotal} databases · ${s.collectionsScanned} collections learned${s.currentDb ? ` · ${s.currentDb}` : ''}`);
            setTimeout(poll, 4000);
          } else if (s.status === 'done') {
            setDeepScanInfo(`Learned ${s.collectionsScanned} collections across ${s.dbDone}/${s.dbTotal} databases`);
            setDeepScanStatus('done');
          } else if (s.status === 'error') {
            setDeepScanStatus('idle');
          } else {
            setTimeout(poll, 4000);
          }
        } catch {
          setTimeout(poll, 6000);
        }
      };
      setTimeout(poll, 3000);
    } catch {
      setDeepScanStatus('idle');
    }
  }, []);

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
    setShowConnect(true);
  };

  const handleSelectDatabase = async (db: Database) => {
    setSelectedDb(db);
    setSchema(null);
    setMessages([]);
    setSuggestions([]);
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
          deepScanStatus={deepScanStatus}
          deepScanInfo={deepScanInfo}
          onScanAll={handleScanAll}
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
    </div>
  );
}
