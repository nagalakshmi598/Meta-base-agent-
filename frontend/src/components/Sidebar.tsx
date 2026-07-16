import { useState } from 'react';
import {
  Database, Table2, ChevronRight, ChevronDown,
  LogOut, Loader2, ChevronLeft,
  Lightbulb, Hash, Type, Calendar, ToggleLeft, Sparkles, Code2
} from 'lucide-react';
import type { Database as DB, Schema, Table, Field, ConnectionState } from '../types';

interface Props {
  open: boolean;
  connection: ConnectionState;
  databases: DB[];
  selectedDb: DB | null;
  schema: Schema | null;
  schemaLoading: boolean;
  suggestions: string[];
  aiEnabled: boolean;
  scanStatus: 'idle' | 'scanning' | 'ready';
  scanCount: number;
  onSelectDatabase: (db: DB) => void;
  onDisconnect: () => void;
  onShowConnect: () => void;
  onToggle: () => void;
  onUseSuggestion: (q: string) => void;
}

// Brand-style fallback: a blue soundwave → wave mark + "CloudFuze" wordmark
// (matches the CloudFuze logo). Shown only if /cloudfuze-logo.png isn't present.
function CloudFuzeLogo() {
  return (
    <svg width="140" height="34" viewBox="0 0 140 34" fill="none" xmlns="http://www.w3.org/2000/svg" aria-label="CloudFuze">
      <g stroke="#1e3a8a" strokeLinecap="round" fill="none">
        {/* soundwave bars flowing into a wave */}
        <path d="M3 13 h7"  strokeWidth="2" />
        <path d="M1 18 h11" strokeWidth="2" />
        <path d="M5 23 h9"  strokeWidth="2" />
        <path d="M15 21 C20 9, 29 9, 33 16 C35 20, 40 21, 45 17" strokeWidth="2.6" />
      </g>
      {/* wordmark */}
      <text x="52" y="24" fontFamily="-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif" fontWeight="800" fontSize="17" fill="#0129ac" letterSpacing="-0.5">CloudFuze</text>
    </svg>
  );
}

// Uses your real CloudFuze logo from frontend/public/ — tries common names AND
// formats (png/svg/jpg/webp) so whatever you save "just works". Falls back to
// the drawn SVG only if no logo file is found.
const LOGO_CANDIDATES = [
  '/cloudfuze-logo.png', '/cloudfuze-logo.svg', '/cloudfuze-logo.jpg', '/cloudfuze-logo.jpeg', '/cloudfuze-logo.webp',
  '/logo.png', '/logo.svg', '/logo.jpg', '/cloudfuze.png', '/cloudfuze.svg', '/cloudfuze.jpg',
];
function Logo() {
  const [idx, setIdx] = useState(0);
  if (idx < LOGO_CANDIDATES.length) {
    return (
      <img
        key={idx}
        src={LOGO_CANDIDATES[idx]}
        alt="CloudFuze"
        style={{ height: 34, width: 'auto', maxWidth: 170, objectFit: 'contain' }}
        onError={() => setIdx(i => i + 1)}
      />
    );
  }
  return <CloudFuzeLogo />;
}

function FieldIcon({ type }: { type: string }) {
  if (type?.includes('Integer') || type?.includes('Float') || type?.includes('Decimal')) {
    return <Hash size={11} className="text-[#0129ac] flex-shrink-0" />;
  }
  if (type?.includes('Date') || type?.includes('Time')) {
    return <Calendar size={11} className="text-purple-500 flex-shrink-0" />;
  }
  if (type?.includes('Boolean')) {
    return <ToggleLeft size={11} className="text-green-500 flex-shrink-0" />;
  }
  return <Type size={11} className="text-gray-400 flex-shrink-0" />;
}

function TableRow({ table }: { table: Table }) {
  const [expanded, setExpanded] = useState(false);
  const fields = table.fields || [];

  return (
    <div>
      <button
        onClick={() => setExpanded(e => !e)}
        className="w-full flex items-center gap-2 px-3 py-1.5 text-sm text-gray-600 hover:text-gray-900 hover:bg-gray-50 rounded-md transition-colors group"
      >
        <Table2 size={13} className="text-gray-400 flex-shrink-0" />
        <span className="flex-1 text-left truncate text-xs font-mono">{table.name}</span>
        {fields.length > 0 && (
          <span className="text-gray-400 text-xs mr-1">{fields.length}</span>
        )}
        {fields.length > 0 && (
          expanded
            ? <ChevronDown size={12} className="text-gray-400 flex-shrink-0" />
            : <ChevronRight size={12} className="text-gray-400 flex-shrink-0" />
        )}
      </button>

      {expanded && fields.length > 0 && (
        <div className="ml-4 mb-1 space-y-0.5">
          {fields.map((f: Field) => (
            <div
              key={f.id}
              className="flex items-center gap-2 px-2 py-1 rounded text-xs text-gray-500 hover:text-gray-700"
            >
              <FieldIcon type={f.base_type || ''} />
              <span className="truncate font-mono">{f.name}</span>
              <span className="ml-auto text-gray-400 text-[10px] shrink-0">
                {(f.base_type || '').replace('type/', '')}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export default function Sidebar({
  open, connection, databases, selectedDb, schema, schemaLoading,
  suggestions, aiEnabled, scanStatus, scanCount,
  onSelectDatabase, onDisconnect, onToggle, onUseSuggestion
}: Props) {
  const [activeTab, setActiveTab] = useState<'schema' | 'suggestions'>('schema');
  const [dbMenuOpen, setDbMenuOpen] = useState(false);
  const [dbSearch, setDbSearch] = useState('');

  const hostname = connection.url
    ? new URL(connection.url.startsWith('http') ? connection.url : `https://${connection.url}`).hostname
    : '';

  return (
    <>
      {/* Collapsed toggle button */}
      {!open && (
        <button
          onClick={onToggle}
          className="flex-shrink-0 w-10 bg-white border-r border-gray-200 flex items-center justify-center hover:bg-gray-50 transition-colors"
        >
          <ChevronRight size={18} className="text-gray-400" />
        </button>
      )}

      {open && (
        <aside className="flex-shrink-0 w-64 bg-white border-r border-gray-200 flex flex-col">
          {/* Header — CloudFuze Logo */}
          <div className="flex items-center justify-between px-4 py-3 border-b border-gray-200">
            <Logo />
            <button
              onClick={onToggle}
              className="text-gray-400 hover:text-gray-600 transition-colors flex-shrink-0 p-1 rounded hover:bg-gray-100"
            >
              <ChevronLeft size={16} />
            </button>
          </div>

          {/* Connection label */}
          <div className="px-4 py-1.5 bg-[#0129ac]/5 border-b border-[#0129ac]/10">
            <p className="text-[10px] text-[#0129ac]/70 font-medium truncate">{hostname}</p>
          </div>

          {/* Database selector */}
          <div className="px-3 py-3 border-b border-gray-200">
            <p className="text-xs text-gray-400 uppercase tracking-wider mb-2 px-1">Database</p>
            <div className="relative">
              <button
                onClick={() => setDbMenuOpen(o => !o)}
                className="w-full flex items-center gap-2 bg-gray-50 hover:bg-gray-100 border border-gray-200 rounded-lg px-3 py-2 text-sm transition-colors"
              >
                <Database size={14} className="text-[#0129ac] flex-shrink-0" />
                <span className="flex-1 text-left truncate text-xs text-gray-700">
                  {selectedDb ? selectedDb.name : 'Select database...'}
                </span>
                <ChevronDown size={13} className={`text-gray-400 flex-shrink-0 transition-transform ${dbMenuOpen ? 'rotate-180' : ''}`} />
              </button>

              {dbMenuOpen && (
                <div className="absolute z-50 top-full left-0 right-0 mt-1 bg-white border border-gray-200 rounded-lg shadow-xl flex flex-col"
                  style={{ maxHeight: '60vh' }}>
                  {/* Search box */}
                  <div className="px-2 pt-2 pb-1 border-b border-gray-100 flex-shrink-0">
                    <input
                      type="text"
                      placeholder="Search databases..."
                      autoFocus
                      onChange={e => setDbSearch(e.target.value)}
                      className="w-full bg-gray-50 text-gray-700 text-xs px-2 py-1.5 rounded border border-gray-200 focus:outline-none focus:border-[#0129ac] placeholder-gray-400"
                    />
                  </div>
                  {/* Scrollable list */}
                  <div className="overflow-y-auto flex-1">
                    {databases.length === 0 ? (
                      <p className="text-gray-400 text-xs px-3 py-2">No databases found</p>
                    ) : (
                      databases
                        .filter(db => !dbSearch || db.name.toLowerCase().includes(dbSearch.toLowerCase()))
                        .map(db => (
                          <button
                            key={db.id}
                            onClick={() => { onSelectDatabase(db); setDbMenuOpen(false); setDbSearch(''); }}
                            className={`w-full flex items-center gap-2 px-3 py-2 text-sm transition-colors hover:bg-gray-50 ${
                              selectedDb?.id === db.id ? 'text-[#0129ac] bg-[#0129ac]/5' : 'text-gray-600'
                            }`}
                          >
                            <Database size={13} className="flex-shrink-0" />
                            <span className="truncate text-xs">{db.name}</span>
                            {selectedDb?.id === db.id && (
                              <span className="ml-auto text-[#0129ac] text-[10px] flex-shrink-0 font-medium">active</span>
                            )}
                          </button>
                        ))
                    )}
                  </div>
                </div>
              )}
            </div>
          </div>

          {/* Tabs */}
          {selectedDb && (
            <div className="flex border-b border-gray-200">
              {(['schema', 'suggestions'] as const).map(tab => (
                <button
                  key={tab}
                  onClick={() => setActiveTab(tab)}
                  className={`flex-1 py-2 text-xs font-medium transition-colors ${
                    activeTab === tab
                      ? 'text-[#0129ac] border-b-2 border-[#0129ac]'
                      : 'text-gray-400 hover:text-gray-600'
                  }`}
                >
                  {tab === 'schema' ? 'Schema' : 'Suggestions'}
                </button>
              ))}
            </div>
          )}

          {/* Scan status banner */}
          {scanStatus === 'scanning' && (
            <div className="mx-2 mt-2 flex items-center gap-2 rounded-md bg-[#0129ac]/8 border border-[#0129ac]/20 px-3 py-1.5">
              <Loader2 size={11} className="animate-spin text-[#0129ac] flex-shrink-0" />
              <span className="text-xs text-[#0129ac]">Learning all collections…</span>
            </div>
          )}
          {scanStatus === 'ready' && scanCount > 0 && (
            <div className="mx-2 mt-2 flex items-center gap-2 rounded-md bg-green-50 border border-green-200 px-3 py-1.5">
              <span className="text-xs text-green-700">✓ Learned {scanCount} collections</span>
            </div>
          )}

          {/* Tab content */}
          <div className="flex-1 overflow-y-auto">
            {schemaLoading ? (
              <div className="flex items-center justify-center py-12">
                <Loader2 size={20} className="animate-spin text-[#0129ac]" />
              </div>
            ) : activeTab === 'schema' && schema ? (
              <div className="py-2 px-1 space-y-0.5">
                {(schema.tables || []).map(table => (
                  <TableRow key={table.id} table={table} />
                ))}
                {schema.tables?.length === 0 && (
                  <p className="text-gray-400 text-xs text-center py-8">No tables found</p>
                )}
              </div>
            ) : activeTab === 'suggestions' && suggestions.length > 0 ? (
              <div className="py-3 px-3 space-y-2">
                <p className="text-xs text-gray-400 mb-3 flex items-center gap-1">
                  <Lightbulb size={12} />
                  Click a suggestion to use it
                </p>
                {suggestions.map((s, i) => (
                  <button
                    key={i}
                    onClick={() => onUseSuggestion(s)}
                    className="w-full text-left text-xs text-gray-600 hover:text-gray-900 bg-gray-50 hover:bg-[#0129ac]/5 border border-gray-200 hover:border-[#0129ac]/30 rounded-lg px-3 py-2.5 transition-colors"
                  >
                    {s}
                  </button>
                ))}
              </div>
            ) : !selectedDb ? (
              <div className="flex flex-col items-center justify-center py-12 px-4 text-center">
                <Database size={28} className="text-gray-300 mb-3" />
                <p className="text-gray-400 text-sm">Select a database to explore its schema</p>
              </div>
            ) : null}
          </div>

          {/* Footer */}
          <div className="border-t border-gray-200 px-3 py-3 space-y-2">
            {/* AI / SQL mode badge */}
            <div className={`flex items-center gap-1.5 px-2 py-1.5 rounded-lg text-xs ${
              aiEnabled
                ? 'bg-[#0129ac]/10 border border-[#0129ac]/20 text-[#0129ac]'
                : 'bg-gray-100 border border-gray-200 text-gray-500'
            }`}>
              {aiEnabled
                ? <Sparkles size={12} className="flex-shrink-0" />
                : <Code2 size={12} className="flex-shrink-0" />}
              <span className="truncate">
                {aiEnabled ? 'AI mode active' : 'Keyword mode'}
              </span>
            </div>
            {/* Connection row */}
            <div className="flex items-center gap-1 mb-2">
              <div className="w-2 h-2 rounded-full bg-green-500 animate-pulse" />
              <span className="text-xs text-gray-400 flex-1 truncate">Connected</span>
            </div>
            {/* Clear, labeled sign-out button */}
            <button
              onClick={onDisconnect}
              title="Sign out of Metabase"
              className="w-full flex items-center justify-center gap-2 text-sm font-medium text-gray-600 border border-gray-200 rounded-lg py-2 hover:text-red-600 hover:border-red-200 hover:bg-red-50 transition-colors"
            >
              <LogOut size={15} /> Sign out
            </button>
          </div>
        </aside>
      )}
    </>
  );
}
