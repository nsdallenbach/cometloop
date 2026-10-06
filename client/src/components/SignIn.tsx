import { useState, type CSSProperties, type FormEvent } from 'react';
import { authClient, resetAccessToken } from '../auth';
import { mono } from '../util';

/**
 * The console's own sign-in (Neon Auth — managed Better Auth). Shown when the
 * server answered 401 and `/api/auth/config` names a provider: email +
 * password, with sign-up on the same screen (the branch allows it without
 * verification; testers are added to the workspace by an admin first, or they
 * meet `No workspace` after signing in). Google is the shared Neon provider.
 *
 * Styling follows the console's signed-out screen: theme tokens, DM Sans,
 * mono() labels — the desktop shows this inside its webview unchanged.
 */
export function SignIn({ onSignedIn }: { onSignedIn: () => void }) {
  const [mode, setMode] = useState<'in' | 'up'>('in');
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const fail = (e: unknown) => {
    const msg = e && typeof e === 'object' && 'message' in e && typeof e.message === 'string' ? e.message : 'Sign-in failed';
    setError(msg);
  };

  const submit = async (ev: FormEvent) => {
    ev.preventDefault();
    setBusy(true);
    setError('');
    try {
      const client = await authClient();
      if (!client) throw new Error('This deployment has no sign-in provider configured.');
      const res =
        mode === 'in'
          ? await client.signIn.email({ email: email.trim(), password })
          : await client.signUp.email({ email: email.trim(), password, name: name.trim() || email.trim().split('@')[0] });
      if (res.error) {
        setError(res.error.message ?? (mode === 'in' ? 'Email or password not recognised' : 'Could not create the account'));
        return;
      }
      resetAccessToken();
      onSignedIn();
    } catch (e) {
      fail(e);
    } finally {
      setBusy(false);
    }
  };

  const google = async () => {
    setBusy(true);
    setError('');
    try {
      const client = await authClient();
      if (!client) throw new Error('This deployment has no sign-in provider configured.');
      // Redirects away; the trusted-origin list on the Neon branch must include this origin.
      const res = await client.signIn.social({ provider: 'google', callbackURL: window.location.origin + window.location.pathname });
      if (res.error) setError(res.error.message ?? 'Google sign-in failed');
    } catch (e) {
      fail(e);
    } finally {
      setBusy(false);
    }
  };

  const field: CSSProperties = {
    width: '100%',
    boxSizing: 'border-box',
    background: 'var(--bg2)',
    border: '1px solid var(--line2)',
    borderRadius: 6,
    color: 'var(--tx)',
    padding: '9px 11px',
    fontSize: 13,
    fontFamily: 'inherit',
    outline: 'none',
  };
  const label: CSSProperties = { ...mono(500, 10), color: 'var(--tx3)', letterSpacing: '.08em', display: 'block', marginBottom: 5 };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 14, textAlign: 'center', width: 340, maxWidth: '92vw' }}>
      <div style={{ ...mono(500, 11), color: 'var(--tx3)', letterSpacing: '.08em' }}>COMETLOOP</div>
      <div style={{ fontSize: 18, fontWeight: 600 }}>{mode === 'in' ? 'Sign in' : 'Create your account'}</div>
      <form onSubmit={(e) => void submit(e)} style={{ display: 'grid', gap: 12, width: '100%', textAlign: 'left' }}>
        {mode === 'up' && (
          <div>
            <label style={label} htmlFor="signin-name">
              NAME
            </label>
            <input id="signin-name" style={field} value={name} onChange={(e) => setName(e.target.value)} autoComplete="name" disabled={busy} />
          </div>
        )}
        <div>
          <label style={label} htmlFor="signin-email">
            EMAIL
          </label>
          <input
            id="signin-email"
            style={field}
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
          <label style={label} htmlFor="signin-password">
            PASSWORD
          </label>
          <input
            id="signin-password"
            style={field}
            type="password"
            required
            minLength={8}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete={mode === 'in' ? 'current-password' : 'new-password'}
            disabled={busy}
          />
        </div>
        {error && (
          <div role="alert" style={{ fontSize: 12, color: 'var(--bad)', lineHeight: 1.4 }}>
            {error}
          </div>
        )}
        <button
          type="submit"
          disabled={busy}
          style={{
            background: 'var(--acc)',
            color: '#fff',
            border: 'none',
            borderRadius: 6,
            padding: '10px 14px',
            fontSize: 13,
            fontWeight: 600,
            cursor: busy ? 'wait' : 'pointer',
            fontFamily: 'inherit',
          }}
        >
          {busy ? 'One moment…' : mode === 'in' ? 'Sign in' : 'Create account'}
        </button>
      </form>
      <button
        type="button"
        onClick={() => void google()}
        disabled={busy}
        style={{
          width: '100%',
          background: 'transparent',
          border: '1px solid var(--line2)',
          color: 'var(--tx)',
          borderRadius: 6,
          padding: '9px 14px',
          fontSize: 13,
          cursor: busy ? 'wait' : 'pointer',
          fontFamily: 'inherit',
        }}
      >
        Continue with Google
      </button>
      <button
        type="button"
        onClick={() => {
          setMode(mode === 'in' ? 'up' : 'in');
          setError('');
        }}
        style={{ ...mono(500, 10), background: 'none', border: 'none', color: 'var(--tx2)', cursor: 'pointer', letterSpacing: '.06em' }}
      >
        {mode === 'in' ? 'NEW HERE? CREATE AN ACCOUNT' : 'HAVE AN ACCOUNT? SIGN IN'}
      </button>
    </div>
  );
}
