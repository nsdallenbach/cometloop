import { useState, type CSSProperties, type FormEvent, type ReactNode } from 'react';
import { Wordmark } from '../../../../shared/design/Brand';

/**
 * The sign-in gate: nothing of the shell — sidebar, agents, deploys, the
 * embedded console — renders until the desktop holds a sign-in. Which
 * sign-in depends on the environment's console:
 *
 *  - Databricks Apps proxy in front: the browser OAuth flow (one button).
 *  - The console signs users in itself (Neon Auth): a native email +
 *    password form with create-account, mirroring the console's own screen.
 *    The session lives in the main process, which mints the console's JWT
 *    and injects it into every request, the embedded console's included.
 *  - No provider and the config request failed: the error, and a retry.
 *
 * Every failure shows its message; no path silently re-renders the form.
 * Styles follow the console client (inline, theme tokens, DM Mono labels).
 */
const mono = (weight: number, size: number): CSSProperties => ({ fontFamily: "'DM Mono', monospace", fontWeight: weight, fontSize: size });

const PASSWORD_MIN = 8;

const input: CSSProperties = {
  width: '100%',
  boxSizing: 'border-box',
  background: 'var(--bg2)',
  border: '1px solid var(--line2)',
  borderRadius: 3,
  color: 'var(--tx)',
  padding: '10px 12px',
  fontSize: 14,
  fontFamily: 'inherit',
  outline: 'none',
};
const label: CSSProperties = { ...mono(500, 10.5), color: 'var(--tx3)', letterSpacing: '.08em', display: 'block', marginBottom: 6 };
const primary: CSSProperties = {
  width: '100%',
  background: 'var(--acc)',
  color: '#fff',
  border: 'none',
  borderRadius: 4,
  padding: '11px 14px',
  fontSize: 14,
  fontWeight: 600,
  fontFamily: 'inherit',
  cursor: 'pointer',
};
const alert: CSSProperties = { fontSize: 13, color: 'var(--bad)', lineHeight: 1.45, padding: '8px 10px', border: '1px solid var(--bad)', borderRadius: 3 };

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
  const [mode, setMode] = useState<'in' | 'up'>('in');
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const host = status.host.replace(/^https?:\/\//, '');

  const shell = (children: ReactNode) => (
    <div style={{ flex: 1, minHeight: 0, display: 'grid', placeItems: 'center', background: 'var(--bg)', overflowY: 'auto' }}>
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 22, width: 380, maxWidth: '92%', padding: '32px 0' }}>
        <Wordmark size={22} />
        <div style={{ ...mono(400, 10.5), color: 'var(--tx3)', letterSpacing: '.08em', marginTop: -10 }}>
          {environmentLabel.toUpperCase()} · {host}
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
        <p style={{ margin: 0, fontSize: 14, color: 'var(--tx2)', lineHeight: 1.55 }}>
          Your browser opens the workspace sign-in; the app picks up the result and keeps you signed in across restarts.
        </p>
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
  const submit = async (ev: FormEvent) => {
    ev.preventDefault();
    setError('');
    if (mode === 'up') {
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
    const res =
      mode === 'in'
        ? await window.desktopBridge.authLoginConsole(email.trim(), password)
        : await window.desktopBridge.authSignUpConsole(name.trim(), email.trim(), password);
    setBusy(false);
    if (res.ok) onSignedIn(res.status);
    else setError(res.error);
  };
  const pick = (m: 'in' | 'up') => {
    setMode(m);
    setError('');
    setConfirm('');
  };

  return shell(
    <>
      <div
        role="tablist"
        aria-label="Sign in or create an account"
        style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', width: '100%', border: '1px solid var(--line2)', borderRadius: 4, overflow: 'hidden' }}
      >
        {(
          [
            ['in', 'Sign in'],
            ['up', 'Create an account'],
          ] as const
        ).map(([m, text]) => (
          <button
            key={m}
            role="tab"
            type="button"
            aria-selected={mode === m}
            onClick={() => pick(m)}
            disabled={busy}
            className="no-drag"
            style={{
              padding: '10px 12px',
              fontSize: 14,
              fontWeight: mode === m ? 600 : 500,
              fontFamily: 'inherit',
              background: mode === m ? 'var(--bg3)' : 'transparent',
              color: mode === m ? 'var(--tx)' : 'var(--tx2)',
              border: 'none',
              cursor: busy ? 'default' : 'pointer',
            }}
          >
            {text}
          </button>
        ))}
      </div>

      <form onSubmit={(e) => void submit(e)} style={{ display: 'grid', gap: 14, width: '100%' }} noValidate>
        {mode === 'up' && (
          <div>
            <label style={label} htmlFor="gate-name">
              NAME
            </label>
            <input id="gate-name" className="no-drag" style={input} value={name} onChange={(e) => setName(e.target.value)} autoComplete="name" disabled={busy} />
          </div>
        )}
        <div>
          <label style={label} htmlFor="gate-email">
            EMAIL
          </label>
          <input
            id="gate-email"
            className="no-drag"
            style={input}
            type="email"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            autoComplete="email"
            autoFocus
            disabled={busy}
          />
        </div>
        <div>
          <label style={label} htmlFor="gate-password">
            PASSWORD
          </label>
          <input
            id="gate-password"
            className="no-drag"
            style={input}
            type="password"
            required
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete={mode === 'in' ? 'current-password' : 'new-password'}
            disabled={busy}
          />
          {mode === 'up' && <div style={{ ...mono(400, 10.5), color: 'var(--tx3)', marginTop: 5 }}>At least {PASSWORD_MIN} characters.</div>}
        </div>
        {mode === 'up' && (
          <div>
            <label style={label} htmlFor="gate-confirm">
              CONFIRM PASSWORD
            </label>
            <input
              id="gate-confirm"
              className="no-drag"
              style={{ ...input, borderColor: confirm && confirm !== password ? 'var(--bad)' : 'var(--line2)' }}
              type="password"
              required
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
              autoComplete="new-password"
              disabled={busy}
            />
          </div>
        )}
        {error && (
          <div role="alert" style={alert}>
            {error}
          </div>
        )}
        <button type="submit" className="no-drag" disabled={busy} style={{ ...primary, cursor: busy ? 'wait' : 'pointer' }}>
          {busy ? 'One moment…' : mode === 'in' ? 'Sign in' : 'Create account'}
        </button>
      </form>
      <p style={{ margin: 0, fontSize: 12.5, color: 'var(--tx3)', lineHeight: 1.5, textAlign: 'center' }}>
        Signing in here signs you in everywhere in the app, the embedded console included. Nothing runs on this machine until you do.
      </p>
    </>,
  );
}
