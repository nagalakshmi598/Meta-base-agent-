import { useState, useEffect } from 'react';
import { X, Link2, Mail, Users, Check, Copy, Loader2, Trash2 } from 'lucide-react';
import { chatApi } from '../services/api';

interface Props {
  // Persists the current conversation and resolves to its chat id.
  ensureSaved: () => Promise<string>;
  onClose: () => void;
}

// Microsoft Teams "share to Teams" launcher.
const teamsShareUrl = (url: string, text: string) =>
  `https://teams.microsoft.com/share?href=${encodeURIComponent(url)}&msgText=${encodeURIComponent(text)}`;

export default function ShareModal({ ensureSaved, onClose }: Props) {
  const [id, setId] = useState<string | null>(null);
  const [url, setUrl] = useState<string>('');
  const [emailsInput, setEmailsInput] = useState('');
  const [sharedWith, setSharedWith] = useState<string[]>([]);
  const [busy, setBusy] = useState(true);
  const [working, setWorking] = useState(false);
  const [copied, setCopied] = useState(false);
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');

  // Save the chat as soon as the modal opens, then load its current share state.
  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const chatId = await ensureSaved();
        if (!alive) return;
        setId(chatId);
        try {
          const { chat } = await chatApi.get(chatId);
          if (!alive) return;
          setSharedWith(chat.sharedWith || []);
          if (chat.hasLink) { const r = await chatApi.shareLink(chatId); if (alive) setUrl(r.url); }
        } catch { /* new chat, nothing shared yet */ }
      } catch (e: any) {
        if (alive) setError(e.message || 'Could not prepare this chat for sharing.');
      } finally {
        if (alive) setBusy(false);
      }
    })();
    return () => { alive = false; };
  }, [ensureSaved]);

  const ensureLink = async (): Promise<string> => {
    if (url) return url;
    if (!id) throw new Error('Chat not saved yet.');
    const r = await chatApi.shareLink(id);
    setUrl(r.url);
    return r.url;
  };

  const handleCopy = async () => {
    setError('');
    try {
      const link = await ensureLink();
      await navigator.clipboard.writeText(link);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch (e: any) {
      setError(e.message || 'Could not copy the link.');
    }
  };

  const handleShareEmails = async () => {
    setError(''); setNotice('');
    const emails = emailsInput.split(/[,;\s]+/).map(s => s.trim()).filter(Boolean);
    const valid = emails.filter(e => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e));
    if (!valid.length) { setError('Enter at least one valid email address.'); return; }
    if (!id) return;
    setWorking(true);
    try {
      const res = await chatApi.shareEmails(id, valid);
      setSharedWith(res.sharedWith);
      setUrl(res.url);
      setEmailsInput('');
      setNotice(`Shared with ${valid.length} ${valid.length === 1 ? 'person' : 'people'}. They can now open this chat after signing in with their Metabase account.`);
    } catch (e: any) {
      setError(e.message || 'Could not share by email.');
    } finally {
      setWorking(false);
    }
  };

  const handleRemove = async (email: string) => {
    if (!id) return;
    try {
      const res = await chatApi.unshareEmail(id, email);
      setSharedWith(res.sharedWith);
    } catch (e: any) {
      setError(e.message || 'Could not remove access.');
    }
  };

  const handleTeams = async () => {
    try { const link = await ensureLink(); window.open(teamsShareUrl(link, 'CloudFuze — shared chat'), '_blank', 'noopener'); }
    catch (e: any) { setError(e.message || 'Could not open Microsoft Teams.'); }
  };

  const handleMailto = async () => {
    try {
      const link = await ensureLink();
      const subject = encodeURIComponent('CloudFuze Metabase — shared chat');
      const body = encodeURIComponent(`I'd like to share this CloudFuze chat with you.\n\nOpen it here (sign in with your Metabase account):\n${link}`);
      window.location.href = `mailto:?subject=${subject}&body=${body}`;
    } catch (e: any) { setError(e.message || 'Could not open your email client.'); }
  };

  const handleRevoke = async () => {
    if (!id) return;
    try { await chatApi.revokeLink(id); setUrl(''); setNotice('The share link has been revoked. Previously copied links no longer work.'); }
    catch (e: any) { setError(e.message || 'Could not revoke the link.'); }
  };

  return (
    <div
      onClick={onClose}
      style={{ position: 'fixed', inset: 0, background: 'rgba(15,23,42,0.45)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000, padding: 16 }}
    >
      <div
        onClick={e => e.stopPropagation()}
        style={{ background: '#fff', borderRadius: 14, width: '100%', maxWidth: 480, boxShadow: '0 20px 60px rgba(0,0,0,0.25)', overflow: 'hidden' }}
      >
        {/* Header */}
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '16px 20px', borderBottom: '1px solid #eef2f7' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <Users size={18} color="#0129ac" />
            <span style={{ fontWeight: 600, color: '#0f172a', fontSize: 15 }}>Share this chat</span>
          </div>
          <button onClick={onClose} style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#94a3b8' }}><X size={18} /></button>
        </div>

        <div style={{ padding: 20, display: 'flex', flexDirection: 'column', gap: 18 }}>
          {busy ? (
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, color: '#64748b', fontSize: 13, padding: '12px 0' }}>
              <Loader2 size={16} className="animate-spin" /> Preparing chat…
            </div>
          ) : (
            <>
              {/* Copy link */}
              <div>
                <div style={{ fontSize: 12, fontWeight: 600, color: '#475569', marginBottom: 6 }}>Share with a link</div>
                <div style={{ display: 'flex', gap: 8 }}>
                  <input
                    readOnly
                    value={url || 'A private link will be created when you copy'}
                    style={{ flex: 1, fontSize: 12, padding: '8px 10px', border: '1px solid #e2e8f0', borderRadius: 8, color: url ? '#0f172a' : '#94a3b8', background: '#f8fafc' }}
                  />
                  <button
                    onClick={handleCopy}
                    style={{ display: 'flex', alignItems: 'center', gap: 6, background: '#0129ac', color: '#fff', border: 'none', borderRadius: 8, padding: '8px 14px', fontSize: 13, fontWeight: 500, cursor: 'pointer', whiteSpace: 'nowrap' }}
                  >
                    {copied ? <Check size={14} /> : <Copy size={14} />}{copied ? 'Copied' : 'Copy link'}
                  </button>
                </div>
                <p style={{ fontSize: 11, color: '#94a3b8', marginTop: 6 }}>Anyone with the link can open this chat after signing in with their own Metabase account.</p>
                {url && (
                  <button onClick={handleRevoke} style={{ background: 'none', border: 'none', color: '#ef4444', fontSize: 11, cursor: 'pointer', marginTop: 2, padding: 0 }}>Revoke link</button>
                )}
              </div>

              {/* Share via email address */}
              <div>
                <div style={{ fontSize: 12, fontWeight: 600, color: '#475569', marginBottom: 6 }}>Invite people by email</div>
                <div style={{ display: 'flex', gap: 8 }}>
                  <input
                    value={emailsInput}
                    onChange={e => setEmailsInput(e.target.value)}
                    onKeyDown={e => { if (e.key === 'Enter') handleShareEmails(); }}
                    placeholder="teammate@cloudfuze.com, another@…"
                    style={{ flex: 1, fontSize: 12, padding: '8px 10px', border: '1px solid #e2e8f0', borderRadius: 8, color: '#0f172a' }}
                  />
                  <button
                    onClick={handleShareEmails}
                    disabled={working}
                    style={{ display: 'flex', alignItems: 'center', gap: 6, background: '#fff', color: '#0129ac', border: '1px solid #0129ac', borderRadius: 8, padding: '8px 14px', fontSize: 13, fontWeight: 500, cursor: working ? 'default' : 'pointer', whiteSpace: 'nowrap', opacity: working ? 0.6 : 1 }}
                  >
                    {working ? <Loader2 size={14} className="animate-spin" /> : <Mail size={14} />} Share
                  </button>
                </div>

                {sharedWith.length > 0 && (
                  <div style={{ marginTop: 10, display: 'flex', flexDirection: 'column', gap: 6 }}>
                    {sharedWith.map(em => (
                      <div key={em} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', background: '#f1f5f9', borderRadius: 8, padding: '6px 10px' }}>
                        <span style={{ fontSize: 12, color: '#334155' }}>{em}</span>
                        <button onClick={() => handleRemove(em)} title="Remove access" style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#94a3b8' }}><Trash2 size={13} /></button>
                      </div>
                    ))}
                  </div>
                )}
              </div>

              {/* Quick send */}
              <div>
                <div style={{ fontSize: 12, fontWeight: 600, color: '#475569', marginBottom: 6 }}>Send via</div>
                <div style={{ display: 'flex', gap: 8 }}>
                  <button onClick={handleTeams} style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6, background: '#f8fafc', border: '1px solid #e2e8f0', borderRadius: 8, padding: '9px', fontSize: 12, fontWeight: 500, color: '#4b53bc', cursor: 'pointer' }}>
                    <Link2 size={14} /> Microsoft Teams
                  </button>
                  <button onClick={handleMailto} style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6, background: '#f8fafc', border: '1px solid #e2e8f0', borderRadius: 8, padding: '9px', fontSize: 12, fontWeight: 500, color: '#334155', cursor: 'pointer' }}>
                    <Mail size={14} /> Email
                  </button>
                </div>
              </div>

              {notice && <div style={{ fontSize: 12, color: '#047857', background: '#ecfdf5', border: '1px solid #a7f3d0', borderRadius: 8, padding: '8px 10px' }}>{notice}</div>}
              {error && <div style={{ fontSize: 12, color: '#dc2626', background: '#fef2f2', border: '1px solid #fecaca', borderRadius: 8, padding: '8px 10px' }}>{error}</div>}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
