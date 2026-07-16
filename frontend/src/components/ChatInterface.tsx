import React, { useState, useRef, useEffect, useCallback } from 'react';
import {
  Send, PanelLeftOpen, Bot, Database,
  Sparkles, AlertCircle, ChevronDown, Code2,
  Mic, Paperclip, X, Share2, Trash2, History, Eye
} from 'lucide-react';
import { aiApi } from '../services/api';
import type { Database as DB, Schema, Message } from '../types';
import MessageBubble from './MessageBubble';

function genId() {
  return Math.random().toString(36).slice(2) + Date.now().toString(36);
}

interface Props {
  selectedDb: DB | null;
  schema: Schema | null;
  messages: Message[];
  suggestions: string[];
  sidebarOpen: boolean;
  aiEnabled: boolean;
  questionToFill?: string;
  onToggleSidebar: () => void;
  onAddMessage: (msg: Message) => void;
  onUpdateMessage: (id: string, updates: Partial<Message>) => void;
  onTruncateFrom?: (id: string) => void;
  onSuggestionsReady: (suggestions: string[]) => void;
  onQuestionFilled?: () => void;
  onOpenShare?: () => void;
  onOpenChats?: () => void;
  onDeleteChat?: () => void;
  readOnly?: boolean;      // viewing a chat shared by someone else
  sharedByLabel?: string;  // owner email when read-only
}

const AI_EXAMPLES = [
  'How many users are available in the message workspace?',
  'Show all workspaces and their current migration status',
  'How many workspaces are in each status (active, failed, completed)?',
  'List all failed or conflict workspaces',
  'How many messages have been migrated so far?',
  'Show workspace migration progress summary',
  'Which workspaces have the most users?',
  'Show recent activity in the last 7 days',
];

const SQL_EXAMPLES = [
  'SELECT COUNT(*) FROM your_table;',
  'SELECT * FROM your_table LIMIT 10;',
  'SELECT status, COUNT(*) FROM your_table GROUP BY status;',
  'SELECT * FROM your_table WHERE status = \'failed\' LIMIT 50;',
];

export default function ChatInterface({
  selectedDb, schema, messages, sidebarOpen, aiEnabled,
  questionToFill, onToggleSidebar, onAddMessage, onUpdateMessage,
  onTruncateFrom, onSuggestionsReady, onQuestionFilled,
  onOpenShare, onOpenChats, onDeleteChat, readOnly, sharedByLabel
}: Props) {
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const [showScrollBtn, setShowScrollBtn] = useState(false);

  // Voice input + image attachments
  type Attached = { mimeType: string; data: string; preview: string; name: string };
  const [attachedImages, setAttachedImages] = useState<Attached[]>([]);
  const [isListening, setIsListening] = useState(false);
  const [voiceSupported, setVoiceSupported] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const recognitionRef = useRef<any>(null);
  const voiceStopRef = useRef(false);       // true = user tapped mic to stop
  const voiceStartRef = useRef(0);          // when this recording session began
  const voiceBaseRef = useRef('');          // committed transcript across restarts
  const VOICE_MAX_MS = 10 * 60 * 1000;      // record up to 10 minutes
  const MAX_IMAGES = 30;                     // paste/upload up to 30 screenshots

  useEffect(() => {
    const SR = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
    setVoiceSupported(!!SR);
  }, []);

  // 🎤 Voice → text (browser Web Speech API). Records continuously and auto-
  // restarts on natural pauses so it keeps going up to 10 minutes instead of
  // cutting off mid-sentence. Tap the mic again to stop.
  const toggleVoice = () => {
    const SR = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
    if (!SR) return;
    if (isListening) { voiceStopRef.current = true; try { recognitionRef.current?.stop(); } catch {} return; }

    voiceStopRef.current = false;
    voiceStartRef.current = Date.now();
    voiceBaseRef.current = (input ? input.trim() + ' ' : '');   // keep any typed text

    const startSession = () => {
      const rec = new SR();
      rec.lang = 'en-US';
      rec.interimResults = true;
      rec.continuous = true;
      rec.onresult = (e: any) => {
        let interim = '', finals = '';
        for (let i = e.resultIndex; i < e.results.length; i++) {
          const t = e.results[i][0].transcript;
          if (e.results[i].isFinal) finals += t + ' '; else interim += t;
        }
        if (finals) voiceBaseRef.current += finals;
        setInput((voiceBaseRef.current + interim).trim());
      };
      rec.onerror = (e: any) => {
        // 'no-speech'/'aborted' are benign during long recordings — let onend restart
        if (e?.error && e.error !== 'no-speech' && e.error !== 'aborted' && e.error !== 'network') {
          voiceStopRef.current = true; setIsListening(false);
        }
      };
      rec.onend = () => {
        const elapsed = Date.now() - voiceStartRef.current;
        if (!voiceStopRef.current && elapsed < VOICE_MAX_MS) {
          try { rec.start(); } catch { setIsListening(false); }   // keep listening
        } else {
          setIsListening(false);
          textareaRef.current?.focus();
        }
      };
      recognitionRef.current = rec;
      rec.start();
    };

    setIsListening(true);
    startSession();
  };

  // 📎 Image/screenshot attachments (upload button + paste)
  const fileToImage = (file: File) => new Promise<Attached>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = String(reader.result);
      resolve({ mimeType: file.type || 'image/png', data: result.split(',')[1] || '', preview: result, name: file.name || 'image' });
    };
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });

  const addFiles = async (files: FileList | File[]) => {
    const imgs = Array.from(files).filter(f => f.type.startsWith('image/'));
    if (!imgs.length) return;
    const read = await Promise.all(imgs.map(fileToImage));
    setAttachedImages(prev => [...prev, ...read].slice(0, MAX_IMAGES)); // up to 30 screenshots
  };

  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files?.length) addFiles(e.target.files);
    e.target.value = '';
  };

  const handlePaste = (e: React.ClipboardEvent) => {
    const items = e.clipboardData?.items;
    if (!items) return;
    const files: File[] = [];
    for (const it of Array.from(items)) {
      if (it.type.startsWith('image/')) { const f = it.getAsFile(); if (f) files.push(f); }
    }
    if (files.length) { e.preventDefault(); addFiles(files); }
  };

  const removeImage = (idx: number) => setAttachedImages(prev => prev.filter((_, i) => i !== idx));

  // Fill input from sidebar suggestion (keeps it editable before sending)
  useEffect(() => {
    if (questionToFill) {
      setInput(questionToFill);
      onQuestionFilled?.();
      setTimeout(() => {
        textareaRef.current?.focus();
        // move cursor to end
        const el = textareaRef.current;
        if (el) el.selectionStart = el.selectionEnd = el.value.length;
      }, 0);
    }
  }, [questionToFill, onQuestionFilled]);

  // Auto-resize textarea
  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = Math.min(el.scrollHeight, 200) + 'px';
  }, [input]);

  // Scroll to bottom on new message
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  // Fetch AI suggestions when schema loads (only in AI mode)
  useEffect(() => {
    if (!schema || !aiEnabled) return;
    aiApi.suggest(schema)
      .then(res => onSuggestionsReady(res.suggestions))
      .catch(() => {});
  }, [schema, aiEnabled, onSuggestionsReady]);

  const handleScroll = () => {
    const el = containerRef.current;
    if (!el) return;
    setShowScrollBtn(el.scrollHeight - el.scrollTop - el.clientHeight > 200);
  };

  const handleSubmit = useCallback(async (
    value: string,
    opts: { history?: { role: 'user' | 'assistant'; content: string }[]; images?: typeof attachedImages } = {}
  ) => {
    const q = value.trim();
    const imgs = opts.images ?? attachedImages;
    if ((!q && imgs.length === 0) || loading || !selectedDb) return;
    if (aiEnabled && !schema) return;

    setInput('');
    setAttachedImages([]);

    const userContent = q || `📎 Analyze the attached ${imgs.length > 1 ? 'screenshots' : 'screenshot'}`;
    const userMsg: Message = {
      id: genId(),
      role: 'user',
      content: userContent,
      timestamp: new Date(),
      imagePreviews: imgs.length ? imgs.map(i => i.preview) : undefined
    };
    onAddMessage(userMsg);

    const assistantId = genId();
    onAddMessage({
      id: assistantId,
      role: 'assistant',
      content: '',
      timestamp: new Date(),
      loading: true
    });

    setLoading(true);
    try {
      const history = opts.history ?? messages
        .filter(m => !m.loading && (m.role === 'user' || m.role === 'assistant'))
        .slice(-8)
        .map(m => ({ role: m.role as 'user' | 'assistant', content: m.content }));

      const payload = aiEnabled
        ? { question: q, database_id: selectedDb.id, schema: schema!, history,
            images: imgs.length ? imgs.map(i => ({ mimeType: i.mimeType, data: i.data })) : undefined }
        : { sql: q, database_id: selectedDb.id };

      const result = await aiApi.query(payload);

      onUpdateMessage(assistantId, {
        loading: false,
        content: result.answer,
        mode: result.mode,
        sql: result.sql,
        explanation: result.explanation,
        tables_used: result.tables_used,
        query_type: result.query_type,
        is_mongo: result.is_mongo,
        collection: result.collection,
        queries: (result as any).queries,
        results: result.results,
        executionTimeMs: result.execution_time_ms
      });
    } catch (err: any) {
      onUpdateMessage(assistantId, {
        loading: false,
        role: 'error',
        content: err.message || 'Query failed',
        sql: err.sql,
        explanation: err.details
      });
    } finally {
      setLoading(false);
    }
  }, [loading, selectedDb, schema, aiEnabled, messages, attachedImages, onAddMessage, onUpdateMessage]);

  // Edit a previously-sent question: drop it and everything after, then re-ask
  // it with the correct history (everything BEFORE the edited message).
  const handleEditResend = useCallback((messageId: string, newText: string) => {
    const text = newText.trim();
    if (!text || loading) return;
    const idx = messages.findIndex(m => m.id === messageId);
    if (idx === -1) return;
    const priorHistory = messages
      .slice(0, idx)
      .filter(m => !m.loading && (m.role === 'user' || m.role === 'assistant'))
      .slice(-8)
      .map(m => ({ role: m.role as 'user' | 'assistant', content: m.content }));
    onTruncateFrom?.(messageId);
    handleSubmit(text, { history: priorHistory, images: [] });
  }, [messages, loading, onTruncateFrom, handleSubmit]);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSubmit(input);
    }
  };

  const handleSqlKeyDown = (e: React.KeyboardEvent) => {
    if ((e.key === 'Enter' && (e.ctrlKey || e.metaKey))) {
      e.preventDefault();
      handleSubmit(input);
    }
  };

  const ready = selectedDb && (aiEnabled ? !!schema : true);
  const isEmpty = messages.length === 0;

  return (
    <div className="flex flex-col h-full bg-gray-50">
      {/* Header */}
      <header className="flex items-center gap-3 px-4 py-3 border-b border-gray-200 bg-white flex-shrink-0">
        {!sidebarOpen && (
          <button
            onClick={onToggleSidebar}
            className="text-gray-400 hover:text-gray-600 transition-colors p-1.5 rounded-lg hover:bg-gray-100"
          >
            <PanelLeftOpen size={18} />
          </button>
        )}
        <div className="flex items-center gap-2">
          <Bot size={18} className="text-[#0129ac]" />
          <span className="text-gray-800 font-semibold text-sm">Metabase Assistant</span>
        </div>

        {/* Mode pill */}
        <div className={`flex items-center gap-1.5 rounded-full px-3 py-1 text-xs font-medium ${
          aiEnabled
            ? 'bg-[#0129ac]/10 text-[#0129ac] border border-[#0129ac]/20'
            : 'bg-gray-100 text-gray-500 border border-gray-200'
        }`}>
          {aiEnabled ? <Sparkles size={11} /> : <Code2 size={11} />}
          {aiEnabled ? 'AI mode' : 'SQL mode'}
        </div>

        {selectedDb && (
          <div className="flex items-center gap-1.5 bg-gray-100 rounded-full px-3 py-1">
            <Database size={11} className="text-[#0129ac]" />
            <span className="text-gray-600 text-xs">{selectedDb.name}</span>
          </div>
        )}

        {/* Chat actions — Chats / Share / Delete */}
        <div className="ml-auto flex items-center gap-1.5">
          <button
            onClick={onOpenChats}
            title="Your chats & chats shared with you"
            className="flex items-center gap-1.5 text-gray-600 hover:text-[#0129ac] hover:bg-gray-100 rounded-lg px-2.5 py-1.5 text-xs font-medium transition-colors"
          >
            <History size={15} /> Chats
          </button>
          {!readOnly && messages.length > 0 && (
            <>
              <button
                onClick={onOpenShare}
                title="Share this chat by link, email, or Teams"
                className="flex items-center gap-1.5 text-white bg-[#0129ac] hover:bg-[#011f85] rounded-lg px-3 py-1.5 text-xs font-medium transition-colors"
              >
                <Share2 size={14} /> Share
              </button>
              <button
                onClick={onDeleteChat}
                title="Delete this chat"
                className="flex items-center text-gray-400 hover:text-red-500 hover:bg-red-50 rounded-lg p-1.5 transition-colors"
              >
                <Trash2 size={15} />
              </button>
            </>
          )}
        </div>
      </header>

      {/* Read-only banner when viewing a shared chat */}
      {readOnly && (
        <div className="flex items-center gap-2 px-4 py-2 bg-amber-50 border-b border-amber-200 text-amber-800 text-xs">
          <Eye size={13} />
          You're viewing a shared chat{sharedByLabel ? <> from <b>{sharedByLabel}</b></> : ''} (read-only).
        </div>
      )}

      {/* Messages */}
      <div
        ref={containerRef}
        onScroll={handleScroll}
        className="flex-1 overflow-y-auto px-4 py-4 relative"
      >
        {isEmpty ? (
          <WelcomeScreen
            selectedDb={selectedDb}
            schema={schema}
            aiEnabled={aiEnabled}
            onQuestion={handleSubmit}
          />
        ) : (
          <div className="max-w-4xl mx-auto space-y-1">
            {messages.map(msg => (
              <MessageBubble key={msg.id} message={msg} schema={schema} onEdit={handleEditResend} />
            ))}
          </div>
        )}
        <div ref={bottomRef} />

        {showScrollBtn && (
          <button
            onClick={() => bottomRef.current?.scrollIntoView({ behavior: 'smooth' })}
            className="fixed bottom-28 right-6 bg-white hover:bg-gray-50 border border-gray-200 text-gray-600 rounded-full p-2 shadow-md transition-all"
          >
            <ChevronDown size={18} />
          </button>
        )}
      </div>

      {/* Input area */}
      <div className="flex-shrink-0 px-4 py-4 border-t border-gray-200 bg-white">
        <div className="max-w-4xl mx-auto space-y-2">

          {/* Warnings */}
          {!selectedDb && (
            <div className="flex items-center gap-2 text-amber-700 text-xs bg-amber-50 border border-amber-200 rounded-lg px-3 py-2">
              <AlertCircle size={13} />
              Select a database from the sidebar to start
            </div>
          )}
          {selectedDb && aiEnabled && !schema && (
            <div className="flex items-center gap-2 text-[#0129ac] text-xs bg-[#0129ac]/5 border border-[#0129ac]/20 rounded-lg px-3 py-2">
              <AlertCircle size={13} />
              Loading schema...
            </div>
          )}

          {/* No AI key notice (SQL mode) */}
          {!aiEnabled && (
            <div className="flex items-start gap-2 text-gray-500 text-xs bg-gray-50 border border-gray-200 rounded-lg px-3 py-2">
              <Code2 size={13} className="mt-0.5 flex-shrink-0 text-gray-400" />
              <span>
                <strong className="text-gray-700">SQL mode</strong> — type a SQL query and press{' '}
                <kbd className="bg-gray-200 px-1 py-0.5 rounded text-gray-600">Ctrl+Enter</kbd> to run.{' '}
                To enable AI mode, add your{' '}
                <a
                  href="https://console.anthropic.com/settings/keys"
                  target="_blank"
                  rel="noreferrer"
                  className="text-[#0129ac] underline hover:text-[#0140d6]"
                >
                  Anthropic API key
                </a>{' '}
                to <code className="bg-gray-100 px-1 rounded">backend/.env</code>.
              </span>
            </div>
          )}

          {/* Input box */}
          <div className={`flex flex-col gap-2 bg-white border rounded-xl px-3 py-2.5 transition-colors shadow-sm ${
            ready
              ? 'border-gray-200 focus-within:border-[#0129ac] focus-within:ring-2 focus-within:ring-[#0129ac]/10'
              : 'border-gray-100 opacity-50'
          }`}>
            {/* Attached image previews */}
            {attachedImages.length > 0 && (
              <div className="px-1 pt-1">
                <div className="flex items-center justify-between mb-1">
                  <span className="text-xs text-gray-500">
                    {attachedImages.length} image{attachedImages.length !== 1 ? 's' : ''} attached
                    {attachedImages.length >= MAX_IMAGES && <span className="text-amber-600"> (max {MAX_IMAGES})</span>}
                  </span>
                  <button onClick={() => setAttachedImages([])} className="text-xs text-gray-400 hover:text-red-500 transition-colors">Clear all</button>
                </div>
                <div className="flex flex-wrap gap-2 max-h-40 overflow-y-auto">
                  {attachedImages.map((img, i) => (
                    <div key={i} className="relative group">
                      <img src={img.preview} alt={img.name} className="h-16 w-16 object-cover rounded-lg border border-gray-200" />
                      <button
                        onClick={() => removeImage(i)}
                        title="Remove"
                        className="absolute -top-1.5 -right-1.5 bg-gray-800 text-white rounded-full w-5 h-5 flex items-center justify-center hover:bg-red-500 transition-colors shadow"
                      >
                        <X size={11} />
                      </button>
                    </div>
                  ))}
                </div>
              </div>
            )}

            <div className="flex items-end gap-2">
              {/* Attach + Voice — AI mode only */}
              {aiEnabled && (
                <>
                  <input ref={fileInputRef} type="file" accept="image/*" multiple onChange={handleFileSelect} className="hidden" />
                  <button
                    onClick={() => fileInputRef.current?.click()}
                    disabled={!ready || loading}
                    title="Attach an image or screenshot"
                    className="flex-shrink-0 w-9 h-9 text-gray-400 hover:text-[#0129ac] hover:bg-[#0129ac]/5 rounded-lg flex items-center justify-center transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                  >
                    <Paperclip size={18} />
                  </button>
                  {voiceSupported && (
                    <button
                      onClick={toggleVoice}
                      disabled={!ready || loading}
                      title={isListening ? 'Stop listening' : 'Speak your question'}
                      className={`flex-shrink-0 w-9 h-9 rounded-lg flex items-center justify-center transition-colors disabled:opacity-40 disabled:cursor-not-allowed ${
                        isListening ? 'bg-red-500 text-white animate-pulse' : 'text-gray-400 hover:text-[#0129ac] hover:bg-[#0129ac]/5'
                      }`}
                    >
                      <Mic size={18} />
                    </button>
                  )}
                </>
              )}

              <textarea
                id="chat-input"
                ref={textareaRef}
                value={input}
                onChange={e => setInput(e.target.value)}
                onKeyDown={aiEnabled ? handleKeyDown : handleSqlKeyDown}
                onPaste={aiEnabled ? handlePaste : undefined}
                placeholder={
                  !selectedDb
                    ? 'Select a database first...'
                    : isListening
                    ? '🎤 Listening… speak now'
                    : aiEnabled
                    ? 'Ask a question, speak 🎤, or paste a screenshot 📎…'
                    : 'Type a SQL query... (Ctrl+Enter to run)'
                }
                disabled={!ready || loading}
                rows={aiEnabled ? 1 : 3}
                className={`flex-1 bg-transparent text-gray-800 placeholder-gray-400 resize-none focus:outline-none text-sm leading-relaxed py-1.5 ${
                  !aiEnabled ? 'font-mono' : ''
                }`}
              />
              <button
                onClick={() => handleSubmit(input)}
                disabled={(!input.trim() && attachedImages.length === 0) || !ready || loading}
                className="flex-shrink-0 w-9 h-9 bg-[#0129ac] hover:bg-[#0140d6] disabled:opacity-40 disabled:cursor-not-allowed rounded-lg flex items-center justify-center transition-colors"
              >
                {loading
                  ? <div className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" />
                  : <Send size={15} className="text-white" />}
              </button>
            </div>
          </div>

          <p className="text-gray-400 text-xs text-center">
            {aiEnabled
              ? 'Enter to send · Shift+Enter for new line · 🎤 speak · 📎 attach or paste a screenshot'
              : 'Ctrl+Enter to run · Enter for new line'}
          </p>
        </div>
      </div>
    </div>
  );
}

function WelcomeScreen({
  selectedDb, schema, aiEnabled, onQuestion
}: {
  selectedDb: DB | null;
  schema: Schema | null;
  aiEnabled: boolean;
  onQuestion: (q: string) => void;
}) {
  const examples = aiEnabled ? AI_EXAMPLES : SQL_EXAMPLES;

  return (
    <div className="max-w-2xl mx-auto flex flex-col items-center justify-center min-h-[60vh] text-center px-4">
      <div className={`w-16 h-16 rounded-2xl flex items-center justify-center mb-6 ${
        aiEnabled
          ? 'bg-[#0129ac]/10 border border-[#0129ac]/20'
          : 'bg-gray-100 border border-gray-200'
      }`}>
        {aiEnabled
          ? <Sparkles size={28} className="text-[#0129ac]" />
          : <Code2 size={28} className="text-gray-400" />}
      </div>

      <h1 className="text-2xl font-bold text-gray-900 mb-2">
        {aiEnabled ? 'CloudFuze AI Assistant' : 'SQL Query Runner'}
      </h1>
      <p className="text-gray-500 text-sm mb-2 max-w-md">
        {aiEnabled
          ? 'Ask questions in plain English — the assistant writes the query, runs it, and explains the results.'
          : 'Type SQL queries directly and run them against your Metabase database.'}
      </p>

      {!aiEnabled && (
        <p className="text-gray-400 text-xs mb-6 max-w-sm">
          Want natural language queries?{' '}
          <a
            href="https://console.anthropic.com/settings/keys"
            target="_blank"
            rel="noreferrer"
            className="text-[#0129ac] underline hover:text-[#0140d6]"
          >
            Get an Anthropic API key
          </a>{' '}
          and add it to <code className="bg-gray-100 px-1 rounded">backend/.env</code>.
        </p>
      )}

      {/* Schema loading spinner */}
      {selectedDb && aiEnabled && !schema && (
        <div className="flex flex-col items-center gap-3 py-6">
          <div className="w-8 h-8 border-2 border-gray-200 border-t-[#0129ac] rounded-full animate-spin" />
          <p className="text-gray-500 text-sm">Loading schema from <span className="text-[#0129ac] font-medium">{selectedDb.name}</span>...</p>
          <p className="text-gray-400 text-xs">This may take a few seconds for large databases</p>
        </div>
      )}

      {selectedDb && (aiEnabled ? !!schema : true) && (
        <div className="w-full">
          <p className="text-gray-400 text-xs uppercase tracking-wider mb-3">
            {aiEnabled ? 'Try asking...' : 'Example queries'}
          </p>
          <div className="grid grid-cols-1 gap-2">
            {examples.map((q, i) => (
              <button
                key={i}
                onClick={() => onQuestion(q)}
                className={`text-left text-sm text-gray-600 hover:text-gray-900 bg-white hover:bg-[#0129ac]/5 border border-gray-200 hover:border-[#0129ac]/30 rounded-xl px-4 py-3 transition-all shadow-sm ${
                  !aiEnabled ? 'font-mono text-xs text-[#0129ac]/80 hover:text-[#0129ac]' : ''
                }`}
              >
                {q}
              </button>
            ))}
          </div>
        </div>
      )}

      {!selectedDb && (
        <div className="flex items-center gap-2 text-gray-400 text-sm bg-gray-50 border border-gray-200 rounded-xl px-6 py-4">
          <Database size={18} className="text-gray-300" />
          <span>Select a database from the left sidebar to get started</span>
        </div>
      )}
    </div>
  );
}
