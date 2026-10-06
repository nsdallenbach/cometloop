import { useEffect, useState, type CSSProperties, type FormEvent, type ReactNode } from 'react';
import { authClient, resetAccessToken, signOut } from '../auth';
import { Wordmark } from './Brand';
import { mono } from '../util';

/**
 * The console's own sign-in (Neon Auth — managed Better Auth). Shown when the
 * server answered 401 or 403 and `/api/auth/config` names a provider.
 *
 * Two modes on one screen, switched by a segmented control: sign in, and
 * create an account (name, email, password + confirmation). Google is the
 * shared Neon provider. The `problem` prop is what the server said after a
 * successful sign-in — today only `no-workspace`: the account exists but its
 * email is not a member of any workspace, so an admin has to add it first.
 * That screen names the email and offers to switch accounts, instead of
 * silently showing the form again.
 *
 * Styling follows the console: theme tokens, DM Sans, mono() labels, the
 * Setup form's input idiom — the desktop shows this inside its webview.
 */
export type SignInProblem = { kind: 'no-workspace' } | null;

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
const secondary: CSSProperties = {
  ...primary,
  background: 'transparent',
  color: 'var(--tx)',
  border: '1px solid var(--line2)',
  fontWeight: 500,
};

export function SignIn({ onSignedIn, problem = null }: { onSignedIn: () => void; problem?: SignInProblem }) {
  const [mode, setMode] = useState<'in' | 'up'>('in');
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState<'idle' | 'submitting' | 'entering'>('idle');
  const [error, setError] = useState('');
  // Who the auth host says is signed in — shown on the no-workspace screen.
  const [sessionEmail, setSessionEmail] = useState('');

  useEffect(() => {
    if (!problem) return;
    void authClient().then(async (client) => {
      if (!client) return;
      const { data } = await client.getSession();
      setSessionEmail(data?.user?.email ?? '');
    });
  }, [problem]);

  const message = (e: unknown, fallback: string) =>
    e && typeof e === 'object' && 'message' in e && typeof e.message === 'string' && e.message ? e.message : fallback;

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
    setBusy('submitting');
    try {
      const client = await authClient();
      if (!client) throw new Error('This deployment has no sign-in provider configured.');
      const res =
        mode === 'in'
          ? await client.signIn.email({ email: email.trim(), password })
          : await client.signUp.email({ email: email.trim(), password, name: name.trim() || email.trim().split('@')[0] });
      if (res.error) {
        setError(res.error.message ?? (mode === 'in' ? 'That email and password were not recognised.' : 'The account could not be created.'));
        setBusy('idle');
        return;
      }
      // Signed in at the auth host; the console now loads as this user. The
      // parent swaps this screen out when `/api/me` answers, or hands back a
      // `problem` if it refuses.
      resetAccessToken();
      setBusy('entering');
      onSignedIn();
    } catch (e) {
      setError(message(e, mode === 'in' ? 'Sign-in failed.' : 'Account creation failed.'));
      setBusy('idle');
    }
  };

  const google = async () => {
    setError('');
    setBusy('submitting');
    try {
      const client = await authClient();
      if (!client) throw new Error('This deployment has no sign-in provider configured.');
      // Redirects away; the trusted-origin list on the Neon branch must include this origin.
      const res = await client.signIn.social({ provider: 'google', callbackURL: window.location.origin + window.location.pathname });
      if (res.error) {
        setError(res.error.message ?? 'Google sign-in failed.');
        setBusy('idle');
      }
    } catch (e) {
      setError(message(e, 'Google sign-in failed.'));
      setBusy('idle');
    }
  };

  const switchAccount = async () => {
    setBusy('submitting');
    await signOut();
    setSessionEmail('');
    setBusy('idle');
    // Back to a clean form; the parent clears `problem` on the next attempt.
    window.location.reload();
  };

  // Reset the form when the mode changes; the error belongs to the old mode.
  const pick = (m: 'in' | 'up') => {
    setMode(m);
    setError('');
    setConfirm('');
  };

  const disabled = busy !== 'idle';

  const shell = (children: ReactNode) => (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 22, width: 380, maxWidth: '92vw' }}>
      <Wordmark size={22} />
      {children}
    </div>
  );

  if (problem?.kind === 'no-workspace') {
    return shell(
      <div style={{ width: '100%', display: 'grid', gap: 14, textAlign: 'center' }}>
        <div style={{ fontSize: 20, fontWeight: 600 }}>You&rsquo;re signed in, but not in a workspace yet</div>
        <p style={{ margin: 0, fontSize: 14, color: 'var(--tx2)', lineHeight: 1.55 }}>
          {sessionEmail ? (
            <>
              <span style={{ color: 'var(--tx)', fontWeight: 600 }}>{sessionEmail}</span> isn&rsquo;t a member of this console. An admin
              has to add that email before it can sign in.
            </>
          ) : (
            <>This account isn&rsquo;t a member of this console. An admin has to add your email before it can sign in.</>
          )}
        </p>
        <button type="button" onClick={onSignedIn} disabled={disabled} style={primary}>
          I&rsquo;ve been added — try again
        </button>
        <button type="button" onClick={() => void switchAccount()} disabled={disabled} style={secondary}>
          Use a different account
        </button>
      </div>,
    );
  }

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
            disabled={disabled}
            style={{
              padding: '10px 12px',
              fontSize: 14,
              fontWeight: mode === m ? 600 : 500,
              fontFamily: 'inherit',
              background: mode === m ? 'var(--bg3)' : 'transparent',
              color: mode === m ? 'var(--tx)' : 'var(--tx2)',
              border: 'none',
              cursor: disabled ? 'default' : 'pointer',
            }}
          >
            {text}
          </button>
        ))}
      </div>

      <form onSubmit={(e) => void submit(e)} style={{ display: 'grid', gap: 14, width: '100%' }} noValidate>
        {mode === 'up' && (
          <div>
            <label style={label} htmlFor="signin-name">
              NAME
            </label>
            <input id="signin-name" style={input} value={name} onChange={(e) => setName(e.target.value)} autoComplete="name" disabled={disabled} />
          </div>
        )}
        <div>
          <label style={label} htmlFor="signin-email">
            EMAIL
          </label>
          <input
            id="signin-email"
            style={input}
            type="email"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            autoComplete="email"
            autoFocus
            disabled={disabled}
          />
        </div>
        <div>
          <label style={label} htmlFor="signin-password">
            PASSWORD
          </label>
          <input
            id="signin-password"
            style={input}
            type="password"
            required
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete={mode === 'in' ? 'current-password' : 'new-password'}
            disabled={disabled}
          />
          {mode === 'up' && <div style={{ ...mono(400, 10.5), color: 'var(--tx3)', marginTop: 5 }}>At least {PASSWORD_MIN} characters.</div>}
        </div>
        {mode === 'up' && (
          <div>
            <label style={label} htmlFor="signin-confirm">
              CONFIRM PASSWORD
            </label>
            <input
              id="signin-confirm"
              style={{ ...input, borderColor: confirm && confirm !== password ? 'var(--bad)' : 'var(--line2)' }}
              type="password"
              required
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
              autoComplete="new-password"
              disabled={disabled}
            />
          </div>
        )}
        {error && (
          <div role="alert" style={{ fontSize: 13, color: 'var(--bad)', lineHeight: 1.45, padding: '8px 10px', border: '1px solid var(--bad)', borderRadius: 3 }}>
            {error}
          </div>
        )}
        <button type="submit" disabled={disabled} style={{ ...primary, cursor: disabled ? 'wait' : 'pointer' }}>
          {busy === 'entering' ? 'Opening the console…' : busy === 'submitting' ? 'One moment…' : mode === 'in' ? 'Sign in' : 'Create account'}
        </button>
      </form>

      <div style={{ display: 'flex', alignItems: 'center', gap: 10, width: '100%', color: 'var(--tx3)', ...mono(400, 10.5), letterSpacing: '.08em' }}>
        <span style={{ flex: 1, height: 1, background: 'var(--line)' }} />
        OR
        <span style={{ flex: 1, height: 1, background: 'var(--line)' }} />
      </div>

      <button type="button" onClick={() => void google()} disabled={disabled} style={{ ...secondary, cursor: disabled ? 'wait' : 'pointer' }}>
        Continue with Google
      </button>
    </>,
  );
}
