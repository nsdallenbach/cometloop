import { useState, type CSSProperties, type FormEvent, type ReactNode } from 'react';
import { Wordmark } from '../../../../shared/design/Brand';

/**
 * The sign-in gate: nothing of the shell — sidebar, agents, deploys, the
 * embedded console — renders until the desktop holds a sign-in. Which
 * sign-in depends on the environment's console:
 *
 *  - Databricks Apps proxy in front: the browser OAuth flow (one button).
 *  - The console signs users in itself (Neon Auth): "Continue in your
 *    browser" opens the console's sign-in page — Google works only in a real
 *    browser — and the app receives a session through a loopback handoff;
 *    email + password is also offered natively for people without Google.
 *  - No provider and the config request failed: the error, and a retry.
 *
 * Every failure shows its message; no path silently re-renders the form.
 */

const PASSWORD_MIN = 8;

const input: CSSProperties = {
  width: '100%',
  boxSizing: 'border-box',
  background: 'var(--bg2)',
  border: '1px solid var(--line2)',
  borderRadius: 4,
  color: 'var(--tx)',
  padding: '11px 12px',
  fontSize: 14,
  fontFamily: 'inherit',
  outline: 'none',
};
const primary: CSSProperties = {
  width: '100%',
  background: 'var(--acc)',
  color: '#fff',
  border: 'none',
  borderRadius: 4,
  padding: '12px 14px',
  fontSize: 14,
  fontWeight: 600,
  fontFamily: 'inherit',
  cursor: 'pointer',
};
const secondary: CSSProperties = { ...primary, background: 'var(--bg2)', color: 'var(--tx)', border: '1px solid var(--line2)' };
const link: CSSProperties = { background: 'none', border: 'none', color: 'var(--tx2)', fontSize: 13, fontFamily: 'inherit', cursor: 'pointer', padding: 0, textDecoration: 'underline', textUnderlineOffset: 3 };
const alert: CSSProperties = { fontSize: 13, color: 'var(--bad)', lineHeight: 1.45, padding: '8px 10px', border: '1px solid var(--bad)', borderRadius: 4, width: '100%', boxSizing: 'border-box' };

export function SignInGate({
  status,
  environmentLabel,
  onSignedIn,
  onStatus,
}: {
  status: AuthStatus;
  environmentLabel: string;
  onSignedIn: (status: AuthStatus) => void;
  onStatus: (status: AuthStatus) => void;
}) {
  const [view, setView] = useState<'browser' | 'email' | 'create'>('browser');
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const host = status.host.replace(/^https?:\/\//, '');

  const shell = (children: ReactNode) => (
    <div style={{ flex: 1, minHeight: 0, display: 'grid', placeItems: 'center', background: 'var(--bg)', overflowY: 'auto' }}>
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 20, width: 360, maxWidth: '92%', padding: '32px 0' }}>
        <Wordmark size={22} />
        <div style={{ fontSize: 13, color: 'var(--tx3)', marginTop: -8 }}>
          {environmentLabel} · {host}
        </div>
        {children}
      </div>
    </div>
  );

  // The console could not say how it signs people in.
  if (status.provider === 'none') {
    return shell(
      <div style={{ width: '100%', display: 'grid', gap: 14, textAlign: 'center' }}>
        <div style={{ fontSize: 20, fontWeight: 600 }}>Sign-in is unavailable</div>
        <div role="alert" style={{ ...alert, textAlign: 'left' }}>
          {status.error ?? 'The console reported no sign-in provider.'}
        </div>
        <button
          type="button"
          disabled={busy}
          style={primary}
          onClick={() => {
            setBusy(true);
            void window.desktopBridge.authRetryDiscovery().then((s) => {
              setBusy(false);
              onStatus(s);
              if (s.mode !== 'signed-out') onSignedIn(s);
            });
          }}
        >
          {busy ? 'Checking…' : 'Try again'}
        </button>
      </div>,
    );
  }

  if (status.provider === 'databricks') {
    const signIn = async () => {
      setBusy(true);
      setError('');
      const res = await window.desktopBridge.authLogin();
      setBusy(false);
      if (res.ok) onSignedIn(res.status);
      else setError(res.error);
    };
    return shell(
      <div style={{ width: '100%', display: 'grid', gap: 14, textAlign: 'center' }}>
        <div style={{ fontSize: 20, fontWeight: 600 }}>Sign in to Databricks</div>
        <p style={{ margin: 0, fontSize: 14, color: 'var(--tx2)', lineHeight: 1.55 }}>Your browser opens the workspace sign-in; the app picks up the result and keeps you signed in across restarts.</p>
        {error && (
          <div role="alert" style={{ ...alert, textAlign: 'left' }}>
            {error}
          </div>
        )}
        <button type="button" onClick={() => void signIn()} disabled={busy} style={{ ...primary, cursor: busy ? 'wait' : 'pointer' }}>
          {busy ? 'Waiting for browser…' : 'Sign in to Databricks'}
        </button>
      </div>,
    );
  }

  // Console account (Neon Auth).
  const viaBrowser = async () => {
    setBusy(true);
    setError('');
    const res = await window.desktopBridge.authLoginConsoleBrowser();
    setBusy(false);
    if (res.ok) onSignedIn(res.status);
    else setError(res.error);
  };

  const submit = async (ev: FormEvent) => {
    ev.preventDefault();
    setError('');
    if (view === 'create') {
      if (password.length < PASSWORD_MIN) {
        setError(`Use at least ${PASSWORD_MIN} characters for the password.`);
        return;
      }
      if (password !== confirm) {
        setError('The two passwords do not match.');
        return;
      }
    }
    setBusy(true);
    const res = view === 'email' ? await window.desktopBridge.authLoginConsole(email.trim(), password) : await window.desktopBridge.authSignUpConsole(name.trim(), email.trim(), password);
    setBusy(false);
    if (res.ok) onSignedIn(res.status);
    else setError(res.error);
  };
  const go = (v: typeof view) => {
    setView(v);
    setError('');
    setConfirm('');
  };

  if (view === 'browser') {
    return shell(
      <div style={{ width: '100%', display: 'grid', gap: 12, textAlign: 'center' }}>
        <div style={{ fontSize: 20, fontWeight: 600, marginBottom: 4 }}>Sign in</div>
        {error && (
          <div role="alert" style={{ ...alert, textAlign: 'left' }}>
            {error}
          </div>
        )}
        <button type="button" className="no-drag" onClick={() => void viaBrowser()} disabled={busy} style={{ ...primary, cursor: busy ? 'wait' : 'pointer' }}>
          {busy ? 'Waiting for your browser…' : 'Continue with Google'}
        </button>
        <button type="button" className="no-drag" onClick={() => go('email')} disabled={busy} style={secondary}>
          Use email and password
        </button>
        <p style={{ margin: '6px 0 0', fontSize: 13, color: 'var(--tx3)', lineHeight: 1.5 }}>Google opens in your browser and sends you back here.</p>
      </div>,
    );
  }

  return shell(
    <form onSubmit={(e) => void submit(e)} style={{ display: 'grid', gap: 12, width: '100%' }} noValidate>
      <div style={{ fontSize: 20, fontWeight: 600, textAlign: 'center', marginBottom: 4 }}>{view === 'email' ? 'Sign in with email' : 'Create an account'}</div>
      {view === 'create' && <input className="no-drag" style={input} placeholder="Your name" value={name} onChange={(e) => setName(e.target.value)} autoComplete="name" disabled={busy} />}
      <input className="no-drag" style={input} type="email" placeholder="Email" required value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="email" autoFocus disabled={busy} />
      <input className="no-drag" style={input} type="password" placeholder={view === 'create' ? `Password (at least ${PASSWORD_MIN} characters)` : 'Password'} required value={password} onChange={(e) => setPassword(e.target.value)} autoComplete={view === 'email' ? 'current-password' : 'new-password'} disabled={busy} />
      {view === 'create' && (
        <input className="no-drag" style={{ ...input, borderColor: confirm && confirm !== password ? 'var(--bad)' : 'var(--line2)' }} type="password" placeholder="Confirm password" required value={confirm} onChange={(e) => setConfirm(e.target.value)} autoComplete="new-password" disabled={busy} />
      )}
      {error && (
        <div role="alert" style={alert}>
          {error}
        </div>
      )}
      <button type="submit" className="no-drag" disabled={busy} style={{ ...primary, cursor: busy ? 'wait' : 'pointer' }}>
        {busy ? 'One moment…' : view === 'email' ? 'Sign in' : 'Create account'}
      </button>
      <div style={{ display: 'flex', justifyContent: 'center', gap: 18, marginTop: 4 }}>
        <button type="button" className="no-drag" style={link} onClick={() => go('browser')} disabled={busy}>
          Back
        </button>
        {view === 'email' ? (
          <button type="button" className="no-drag" style={link} onClick={() => go('create')} disabled={busy}>
            Create an account
          </button>
        ) : (
          <button type="button" className="no-drag" style={link} onClick={() => go('email')} disabled={busy}>
            I have an account
          </button>
        )}
      </div>
    </form>,
  );
}
