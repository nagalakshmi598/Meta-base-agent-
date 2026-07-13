import { useState, useEffect, useRef } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import {
  Bot, User, ChevronDown, ChevronRight, Copy, Check,
  AlertCircle, Table2, Clock, Code2, Pencil
} from 'lucide-react';
import type { Message, Schema } from '../types';

interface Props {
  message: Message;
  schema: Schema | null;
  onEdit?: (id: string, newText: string) => void;
}

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  const copy = () => {
    navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };
  return (
    <button
      onClick={copy}
      className="text-gray-400 hover:text-gray-600 transition-colors p-1 rounded"
      title="Copy"
    >
      {copied ? <Check size={13} className="text-green-500" /> : <Copy size={13} />}
    </button>
  );
}

function QueryBlock({ sql, explanation, isMongo, collection }: { sql: string; explanation?: string; isMongo?: boolean; collection?: string }) {
  const [open, setOpen] = useState(false);

  let displayQuery = sql;
  if (isMongo) {
    try { displayQuery = JSON.stringify(JSON.parse(sql), null, 2); } catch {}
  }

  const label = isMongo ? 'MongoDB Query' : 'Generated SQL';
  const subtitle = isMongo && collection ? `collection: ${collection}` : explanation;

  return (
    <div className="mt-3 border border-gray-200 rounded-xl overflow-hidden">
      <button
        onClick={() => setOpen(o => !o)}
        className="w-full flex items-center gap-2 px-4 py-2.5 bg-gray-50 hover:bg-gray-100 transition-colors text-left"
      >
        <Code2 size={14} className={isMongo ? 'text-green-600 flex-shrink-0' : 'text-[#0129ac] flex-shrink-0'} />
        <span className="text-xs font-medium text-gray-600">{label}</span>
        {subtitle && (
          <span className="text-gray-400 text-xs truncate ml-2 hidden sm:block">{subtitle}</span>
        )}
        <div className="ml-auto flex-shrink-0">
          {open ? <ChevronDown size={14} className="text-gray-400" /> : <ChevronRight size={14} className="text-gray-400" />}
        </div>
      </button>

      {open && (
        <div className="relative">
          <div className="absolute top-2 right-2 z-10">
            <CopyButton text={displayQuery} />
          </div>
          <pre className={`bg-[#1e293b] p-4 text-xs overflow-x-auto font-mono leading-relaxed whitespace-pre-wrap ${isMongo ? 'text-green-300' : 'text-emerald-300'}`}>
            {displayQuery}
          </pre>
        </div>
      )}
    </div>
  );
}

function ResultsTable({ cols, rows, rowCount }: {
  cols: { name: string; display_name?: string }[];
  rows: (string | number | null)[][];
  rowCount: number;
}) {
  const [open, setOpen] = useState(false);
  const [page, setPage] = useState(0);
  const PAGE_SIZE = 50;
  const totalPages = Math.ceil(rows.length / PAGE_SIZE);
  const displayRows = rows.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);

  return (
    <div className="mt-3 border border-gray-200 rounded-xl overflow-hidden">
      <button
        onClick={() => setOpen(o => !o)}
        className="w-full flex items-center gap-2 px-4 py-2.5 bg-gray-50 hover:bg-gray-100 transition-colors text-left"
      >
        <Table2 size={14} className="text-purple-500 flex-shrink-0" />
        <span className="text-xs font-medium text-gray-600">Raw Results</span>
        <span className="ml-2 bg-gray-200 text-gray-600 text-xs px-2 py-0.5 rounded-full">
          {rowCount.toLocaleString()} rows
        </span>
        <div className="ml-auto">
          {open ? <ChevronDown size={14} className="text-gray-400" /> : <ChevronRight size={14} className="text-gray-400" />}
        </div>
      </button>

      {open && rows.length > 0 && (
        <div>
          <div className="overflow-x-auto max-h-80">
            <table className="w-full text-xs">
              <thead className="sticky top-0">
                <tr className="bg-[#f0f4ff]">
                  {cols.map((col, i) => (
                    <th
                      key={i}
                      className="text-left px-3 py-2 text-[#0129ac] font-semibold border-b border-[#dbeafe] whitespace-nowrap"
                    >
                      {col.display_name || col.name}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {displayRows.map((row, i) => (
                  <tr
                    key={i}
                    className={i % 2 === 0 ? 'bg-white' : 'bg-gray-50'}
                  >
                    {row.map((cell, j) => (
                      <td
                        key={j}
                        className="px-3 py-1.5 text-gray-700 border-b border-gray-100 max-w-[200px] truncate"
                        title={cell !== null ? String(cell) : 'NULL'}
                      >
                        {cell === null ? (
                          <span className="text-gray-300 italic">NULL</span>
                        ) : (
                          String(cell)
                        )}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {totalPages > 1 && (
            <div className="flex items-center justify-between px-4 py-2 bg-gray-50 border-t border-gray-200">
              <button
                onClick={() => setPage(p => Math.max(0, p - 1))}
                disabled={page === 0}
                className="text-xs text-gray-500 hover:text-gray-800 disabled:opacity-40 px-2 py-1 rounded hover:bg-gray-200 transition-colors"
              >
                Previous
              </button>
              <span className="text-xs text-gray-400">
                Page {page + 1} of {totalPages} ({rowCount.toLocaleString()} total)
              </span>
              <button
                onClick={() => setPage(p => Math.min(totalPages - 1, p + 1))}
                disabled={page >= totalPages - 1}
                className="text-xs text-gray-500 hover:text-gray-800 disabled:opacity-40 px-2 py-1 rounded hover:bg-gray-200 transition-colors"
              >
                Next
              </button>
            </div>
          )}
        </div>
      )}

      {open && rows.length === 0 && (
        <p className="text-gray-400 text-xs px-4 py-3 text-center">No results returned</p>
      )}
    </div>
  );
}

// User's own message — hover to reveal Copy + Edit; edit shows Cancel/Send inline.
function UserMessage({ message, onEdit }: { message: Message; onEdit?: (id: string, newText: string) => void }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(message.content);
  const [copied, setCopied] = useState(false);
  const taRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (editing && taRef.current) {
      const el = taRef.current;
      el.focus();
      el.style.height = 'auto';
      el.style.height = Math.min(el.scrollHeight, 240) + 'px';
      el.selectionStart = el.selectionEnd = el.value.length;
    }
  }, [editing]);

  const save = () => {
    const t = draft.trim();
    if (!t) return;
    setEditing(false);
    if (t !== message.content) onEdit?.(message.id, t);
  };
  const cancel = () => { setEditing(false); setDraft(message.content); };
  const copy = () => { navigator.clipboard.writeText(message.content); setCopied(true); setTimeout(() => setCopied(false), 1500); };

  if (editing) {
    return (
      <div className="flex gap-3 py-3 max-w-4xl mx-auto justify-end">
        <div className="w-full max-w-[80%] bg-gray-100 rounded-2xl px-4 py-3 border border-gray-200">
          <textarea
            ref={taRef}
            value={draft}
            onChange={e => { setDraft(e.target.value); const el = e.target; el.style.height = 'auto'; el.style.height = Math.min(el.scrollHeight, 240) + 'px'; }}
            onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); save(); } else if (e.key === 'Escape') { cancel(); } }}
            rows={2}
            className="w-full bg-transparent text-gray-800 text-sm resize-none focus:outline-none leading-relaxed"
          />
          <div className="flex justify-end gap-2 mt-2">
            <button onClick={cancel} className="px-3.5 py-1.5 rounded-full text-xs font-medium text-gray-700 bg-white border border-gray-300 hover:bg-gray-50 transition-colors">
              Cancel
            </button>
            <button onClick={save} disabled={!draft.trim()} className="px-4 py-1.5 rounded-full text-xs font-medium text-white bg-[#0129ac] hover:bg-[#0140d6] disabled:opacity-40 disabled:cursor-not-allowed transition-colors">
              Send
            </button>
          </div>
        </div>
        <div className="w-8 h-8 flex-shrink-0" />
      </div>
    );
  }

  return (
    <div className="flex gap-3 py-3 max-w-4xl mx-auto justify-end group">
      <div className="flex flex-col items-end max-w-[80%] min-w-0">
        {message.imagePreviews && message.imagePreviews.length > 0 && (
          <div className="flex flex-wrap gap-2 mb-2 justify-end">
            {message.imagePreviews.map((src, i) => (
              <img key={i} src={src} alt="attachment" className="h-24 w-24 object-cover rounded-lg border border-gray-200" />
            ))}
          </div>
        )}
        <div className="bg-[#0129ac] rounded-2xl rounded-tr-sm px-4 py-3">
          <p className="text-white text-sm leading-relaxed whitespace-pre-wrap">{message.content}</p>
        </div>
        <div className="flex items-center gap-1 mt-1 opacity-0 group-hover:opacity-100 focus-within:opacity-100 transition-opacity">
          <button onClick={copy} title="Copy" className="text-gray-400 hover:text-gray-700 hover:bg-gray-100 p-1.5 rounded-lg transition-colors">
            {copied ? <Check size={13} className="text-green-500" /> : <Copy size={13} />}
          </button>
          {onEdit && (
            <button onClick={() => { setDraft(message.content); setEditing(true); }} title="Edit & resend" className="text-gray-400 hover:text-[#0129ac] hover:bg-[#0129ac]/5 p-1.5 rounded-lg transition-colors">
              <Pencil size={13} />
            </button>
          )}
        </div>
      </div>
      <div className="w-8 h-8 bg-gray-100 rounded-full flex items-center justify-center flex-shrink-0">
        <User size={15} className="text-gray-500" />
      </div>
    </div>
  );
}

export default function MessageBubble({ message, onEdit }: Props) {
  if (message.loading) {
    return (
      <div className="flex gap-3 py-4 max-w-4xl mx-auto">
        <div className="w-8 h-8 bg-[#0129ac]/10 border border-[#0129ac]/20 rounded-full flex items-center justify-center flex-shrink-0">
          <Bot size={15} className="text-[#0129ac]" />
        </div>
        <div className="flex-1 pt-1.5">
          <div className="flex items-center gap-1.5">
            <div className="thinking-dot" />
            <div className="thinking-dot" />
            <div className="thinking-dot" />
            <span className="text-gray-400 text-xs ml-1">Thinking...</span>
          </div>
        </div>
      </div>
    );
  }

  if (message.role === 'user') {
    return <UserMessage message={message} onEdit={onEdit} />;
  }

  if (message.role === 'error') {
    return (
      <div className="flex gap-3 py-3 max-w-4xl mx-auto">
        <div className="w-8 h-8 bg-red-50 border border-red-200 rounded-full flex items-center justify-center flex-shrink-0">
          <AlertCircle size={15} className="text-red-500" />
        </div>
        <div className="flex-1">
          <div className="bg-red-50 border border-red-200 rounded-xl rounded-tl-sm px-4 py-3">
            <p className="text-red-600 text-sm font-medium mb-1">Query Error</p>
            <p className="text-red-500 text-sm">{message.content}</p>
            {message.sql && (
              <div className="mt-3">
                <QueryBlock sql={message.sql} explanation={message.explanation} isMongo={message.is_mongo} collection={message.collection} />
              </div>
            )}
          </div>
        </div>
      </div>
    );
  }

  // Assistant message
  return (
    <div className="flex gap-3 py-3 max-w-4xl mx-auto">
      <div className="w-8 h-8 bg-[#0129ac]/10 border border-[#0129ac]/20 rounded-full flex items-center justify-center flex-shrink-0 mt-1">
        <Bot size={15} className="text-[#0129ac]" />
      </div>

      <div className="flex-1 min-w-0">
        {/* Answer */}
        {message.content && (
          <div className="bg-white border border-gray-200 rounded-xl rounded-tl-sm px-5 py-4 shadow-sm">
            <div className="prose-content">
              <ReactMarkdown
                remarkPlugins={[remarkGfm]}
                components={{
                  // Wrap every table so it scrolls horizontally instead of
                  // squashing/overflowing — keeps columns aligned and readable.
                  table: ({ node, ...props }) => (
                    <div className="table-scroll"><table {...props} /></div>
                  ),
                }}
              >
                {message.content}
              </ReactMarkdown>
            </div>
          </div>
        )}

        {/* AI mode: show generated query (collapsible) */}
        {message.mode === 'ai' && message.sql && (
          <QueryBlock sql={message.sql} explanation={message.explanation} isMongo={message.is_mongo} collection={message.collection} />
        )}

        {/* AI mode: show raw results (collapsible) */}
        {message.mode === 'ai' && message.results && message.results.cols.length > 0 && (
          <ResultsTable
            cols={message.results.cols}
            rows={message.results.rows}
            rowCount={message.results.row_count}
          />
        )}

        {/* SQL mode: show raw results table */}
        {message.mode === 'sql' && message.results && message.results.cols.length > 0 && (
          <ResultsTable
            cols={message.results.cols}
            rows={message.results.rows}
            rowCount={message.results.row_count}
          />
        )}

        {/* Metadata footer */}
        <div className="flex items-center gap-3 mt-2 px-1">
          {message.executionTimeMs && (
            <span className="flex items-center gap-1 text-xs text-gray-400">
              <Clock size={11} />
              {message.executionTimeMs}ms
            </span>
          )}
          <div className="ml-auto">
            {message.content && <CopyButton text={message.content} />}
          </div>
        </div>
      </div>
    </div>
  );
}
