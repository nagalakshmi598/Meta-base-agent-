import { useState, useEffect, useRef } from 'react';
import { Eye, EyeOff, Loader2, LogIn, X, AlertCircle } from 'lucide-react';

interface Props {
  onConnect: (url: string, email: string, password: string) => Promise<void>;
  onClose?: () => void;
}

const LS_URL   = 'mb_url';
const LS_EMAIL = 'mb_email';
const DEFAULT_URL = 'https://metabase.cloudfuze.com';

// CloudFuze logo — uses your real image (any common name/format) if present,
// else a clean wave-mark SVG.
const LOGO_CANDIDATES = [
  '/cloudfuze-logo.png', '/cloudfuze-logo.svg', '/cloudfuze-logo.jpg', '/cloudfuze-logo.jpeg', '/cloudfuze-logo.webp',
  '/logo.png', '/logo.svg', '/logo.jpg', '/cloudfuze.png', '/cloudfuze.svg', '/cloudfuze.jpg',
];
function BrandLogo() {
  const [idx, setIdx] = useState(0);
  if (idx < LOGO_CANDIDATES.length) {
    return <img key={idx} src={LOGO_CANDIDATES[idx]} alt="CloudFuze" style={{ height: 40, width: 'auto', maxWidth: 200, objectFit: 'contain' }} onError={() => setIdx(i => i + 1)} />;
  }
  return (
    <svg width="150" height="38" viewBox="0 0 150 38" fill="none" xmlns="http://www.w3.org/2000/svg" aria-label="CloudFuze">
      <g stroke="#1e3a8a" strokeLinecap="round" fill="none">
        <path d="M4 15 h7"  strokeWidth="2.2" />
        <path d="M2 20 h11" strokeWidth="2.2" />
        <path d="M6 25 h9"  strokeWidth="2.2" />
        <path d="M16 22 C21 10, 30 10, 34 17 C36 21, 41 22, 46 18" strokeWidth="2.8" />
      </g>
      <text x="54" y="26" fontFamily="-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif" fontWeight="800" fontSize="19" fill="#0129ac" letterSpacing="-0.5">CloudFuze</text>
    </svg>
  );
}

export default function ConnectModal({ onConnect, onClose }: Props) {
  const [url,      setUrl]      = useState(() => localStorage.getItem(LS_URL)   || DEFAULT_URL);
  const [email,    setEmail]    = useState(() => localStorage.getItem(LS_EMAIL) || '');
  const [password, setPassword] = useState('');
  const [showPwd,  setShowPwd]  = useState(false);
  const [loading,  setLoading]  = useState(false);
  const [error,    setError]    = useState('');
  const emailRef = useRef<HTMLInputElement>(null);

  useEffect(() => { emailRef.current?.focus(); }, []);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!url.trim() || !email.trim() || !password) { setError('Please enter your Metabase email and password.'); return; }
    setLoading(true);
    setError('');
    try {
      localStorage.setItem(LS_URL,   url.trim());
      localStorage.setItem(LS_EMAIL, email.trim());
      await onConnect(url.trim(), email.trim(), password);
    } catch (err: any) {
      setError(err.message || 'Sign-in failed. Check your credentials and try again.');
    } finally {
      setLoading(false);
    }
  };

  const label: React.CSSProperties = { display:'block', color:'#475569', fontSize:12, fontWeight:600, marginBottom:6 };
  const inp: React.CSSProperties = {
    width:'100%', boxSizing:'border-box', background:'#fff',
    border:'1px solid #e2e8f0', borderRadius:10, padding:'11px 13px',
    color:'#0f172a', fontSize:14, outline:'none', transition:'border-color .15s, box-shadow .15s',
  };
  const focus = (e: React.FocusEvent<HTMLInputElement>) => { e.target.style.borderColor = '#0129ac'; e.target.style.boxShadow = '0 0 0 3px rgba(1,41,172,0.10)'; };
  const blur  = (e: React.FocusEvent<HTMLInputElement>) => { e.target.style.borderColor = '#e2e8f0'; e.target.style.boxShadow = 'none'; };

  return (
    <div style={{
      position:'fixed', inset:0, zIndex:99999,
      display:'flex', alignItems:'center', justifyContent:'center',
      background:'rgba(15,23,42,0.35)', backdropFilter:'blur(6px)',
    }}>
      <div style={{
        background:'#ffffff', borderRadius:20,
        boxShadow:'0 30px 60px rgba(2,20,80,0.22)',
        width:'100%', maxWidth:420, margin:'0 16px', overflow:'hidden',
      }}>
        {onClose && (
          <button onClick={onClose} style={{ position:'absolute', top:14, right:14, background:'none', border:'none', cursor:'pointer', color:'#94a3b8', padding:6, borderRadius:8 }}>
            <X size={18} />
          </button>
        )}

        {/* Brand + heading */}
        <div style={{ padding:'34px 32px 8px', textAlign:'center' }}>
          <div style={{ display:'flex', justifyContent:'center', marginBottom:18 }}><BrandLogo /></div>
          <h1 style={{ margin:0, fontSize:20, fontWeight:700, color:'#0f172a' }}>Sign in</h1>
          <p style={{ margin:'6px 0 0', fontSize:13.5, color:'#64748b', lineHeight:1.5 }}>
            Use your own <strong style={{ color:'#334155' }}>Metabase</strong> email and password to access the CloudFuze Intelligence assistant.
          </p>
        </div>

        {/* Form */}
        <form onSubmit={handleSubmit} style={{ padding:'22px 32px 8px', display:'flex', flexDirection:'column', gap:15 }}>
          <div>
            <label style={label}>Email</label>
            <input ref={emailRef} type="email" value={email} onChange={e => setEmail(e.target.value)}
              placeholder="you@company.com" disabled={loading} style={inp} onFocus={focus} onBlur={blur} autoComplete="username" />
          </div>

          <div>
            <label style={label}>Password</label>
            <div style={{ position:'relative' }}>
              <input type={showPwd ? 'text' : 'password'} value={password} onChange={e => setPassword(e.target.value)}
                placeholder="Your Metabase password" disabled={loading} style={{ ...inp, paddingRight:42 }} onFocus={focus} onBlur={blur} autoComplete="current-password" />
              <button type="button" onClick={() => setShowPwd(s => !s)} tabIndex={-1}
                style={{ position:'absolute', right:12, top:'50%', transform:'translateY(-50%)', background:'none', border:'none', cursor:'pointer', color:'#94a3b8' }}>
                {showPwd ? <EyeOff size={16} /> : <Eye size={16} />}
              </button>
            </div>
          </div>

          <div>
            <label style={label}>Metabase server</label>
            <input type="text" value={url} onChange={e => setUrl(e.target.value)}
              placeholder={DEFAULT_URL} disabled={loading} style={{ ...inp, fontSize:13, color:'#475569' }} onFocus={focus} onBlur={blur} />
          </div>

          {error && (
            <div style={{ display:'flex', alignItems:'flex-start', gap:8, background:'#fef2f2', border:'1px solid #fecaca', borderRadius:10, padding:'10px 12px', color:'#dc2626', fontSize:13 }}>
              <AlertCircle size={15} style={{ flexShrink:0, marginTop:1 }} />
              <span>{error}</span>
            </div>
          )}

          <button type="submit" disabled={loading} style={{
            width:'100%', background: loading ? '#3b5fd1' : '#0129ac', border:'none', borderRadius:11,
            padding:'12px', color:'#fff', fontSize:14.5, fontWeight:600, cursor: loading ? 'not-allowed' : 'pointer',
            display:'flex', alignItems:'center', justifyContent:'center', gap:8, marginTop:4, transition:'background .15s',
          }}>
            {loading ? (<><Loader2 size={16} className="animate-spin" /> Signing in…</>) : (<><LogIn size={16} /> Sign in</>)}
          </button>
        </form>

        <p style={{ color:'#94a3b8', fontSize:11.5, textAlign:'center', padding:'14px 32px 26px', lineHeight:1.5 }}>
          Your credentials are sent directly to your Metabase server for verification.
          Your password is never stored.
        </p>
      </div>
    </div>
  );
}
