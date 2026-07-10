import { useState, useEffect, useCallback } from 'react';
import { X, MessageSquare, Trash2, Loader2, Users, User } from 'lucide-react';
import { chatApi, type ChatSummary } from '../services/api';

interface Props {
  onOpen: (id: string) => void;   // load this chat into the main view
  onClose: () => void;
}

export default function ChatsModal({ onOpen, onClose }: Props) {
  const [chats, setChats] = useState<ChatSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const refresh = useCallback(async () => {
    setLoading(true); setError('');
    try {
      const { chats } = await chatApi.list();
      setChats(chats);
    } catch (e: any) {
      setError(e.message || 'Could not load your chats.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { refresh(); }, [refresh]);

  const handleDelete = async (e: React.MouseEvent, id: string) => {
    e.stopPropagation();
    if (!window.confirm('Delete this chat permanently? This cannot be undone.')) return;
    try { await chatApi.del(id); setChats(prev => prev.filter(c => c.id !== id)); }
    catch (err: any) { setError(err.message || 'Could not delete this chat.'); }
  };

  const mine = chats.filter(c => c.mine);
  const shared = chats.filter(c => !c.mine);

  const when = (iso: string) => { try { return new Date(iso).toLocaleString(); } catch { return ''; } };

  const Row = (c: ChatSummary) => (
    <div
      key={c.id}
      onClick={() => onOpen(c.id)}
      style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '10px 12px', borderRadius: 10, cursor: 'pointer', border: '1px solid #eef2f7' }}
      onMouseEnter={e => (e.currentTarget.style.background = '#f8fafc')}
      onMouseLeave={e => (e.currentTarget.style.background = '#fff')}
    >
      <MessageSquare size={16} color="#0129ac" style={{ flexShrink: 0 }} />
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 13, color: '#0f172a', fontWeight: 500, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{c.title}</div>
        <div style={{ fontSize: 11, color: '#94a3b8' }}>
          {c.messageCount} message{c.messageCount !== 1 ? 's' : ''} · {when(c.updatedAt)}
          {!c.mine && <> · shared by {c.owner}</>}
          {c.mine && c.sharedWith.length > 0 && <> · shared with {c.sharedWith.length}</>}
        </div>
      </div>
      {c.mine && (
        <button onClick={e => handleDelete(e, c.id)} title="Delete chat" style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#cbd5e1', flexShrink: 0 }}>
          <Trash2 size={15} />
        </button>
      )}
    </div>
  );

  return (
    <div onClick={onClose} style={{ position: 'fixed', inset: 0, background: 'rgba(15,23,42,0.45)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000, padding: 16 }}>
      <div onClick={e => e.stopPropagation()} style={{ background: '#fff', borderRadius: 14, width: '100%', maxWidth: 520, maxHeight: '80vh', display: 'flex', flexDirection: 'column', boxShadow: '0 20px 60px rgba(0,0,0,0.25)', overflow: 'hidden' }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '16px 20px', borderBottom: '1px solid #eef2f7' }}>
          <span style={{ fontWeight: 600, color: '#0f172a', fontSize: 15 }}>Your chats</span>
          <button onClick={onClose} style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#94a3b8' }}><X size={18} /></button>
        </div>

        <div style={{ padding: 16, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 16 }}>
          {loading ? (
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, color: '#64748b', fontSize: 13, padding: '12px 0' }}>
              <Loader2 size={16} className="animate-spin" /> Loading…
            </div>
          ) : chats.length === 0 ? (
            <div style={{ color: '#94a3b8', fontSize: 13, textAlign: 'center', padding: '20px 0' }}>No saved chats yet. Ask a question, then use <b>Share</b> to save and share it.</div>
          ) : (
            <>
              <div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11, fontWeight: 600, color: '#64748b', textTransform: 'uppercase', letterSpacing: 0.4, marginBottom: 8 }}>
                  <User size={12} /> My chats ({mine.length})
                </div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                  {mine.length ? mine.map(Row) : <div style={{ fontSize: 12, color: '#94a3b8' }}>None yet.</div>}
                </div>
              </div>
              <div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11, fontWeight: 600, color: '#64748b', textTransform: 'uppercase', letterSpacing: 0.4, marginBottom: 8 }}>
                  <Users size={12} /> Shared with me ({shared.length})
                </div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                  {shared.length ? shared.map(Row) : <div style={{ fontSize: 12, color: '#94a3b8' }}>Nothing shared with you yet.</div>}
                </div>
              </div>
            </>
          )}
          {error && <div style={{ fontSize: 12, color: '#dc2626', background: '#fef2f2', border: '1px solid #fecaca', borderRadius: 8, padding: '8px 10px' }}>{error}</div>}
        </div>
      </div>
    </div>
  );
}
