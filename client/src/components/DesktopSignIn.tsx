import type { ReactNode } from 'react';
import { useCallback, useEffect, useState } from 'react';
import { api, ApiError } from '../api';
import { resetAccessToken } from '../auth';
import { Wordmark } from '../../../shared/design/Brand';
import { SignIn, type SignInProblem } from './SignIn';

/**
 * The page the desktop app opens in the system browser to sign in
 * (`/desktop-signin?port=<loopback>&state=<nonce>`). It runs the console's
 * normal sign-in — Google included, which only works in a real browser —
 * then asks the server for a one-time handoff code and sends the browser to
 * the desktop's loopback listener with it. The desktop exchanges the code
 * for its own session and this tab can be closed.
 */
export function DesktopSignIn({ port, state }: { port: number; state: string }) {
  const [phase, setPhase] = useState<'checking' | 'sign-in' | 'handing-off' | 'done' | 'failed'>('checking');
  const [problem, setProblem] = useState<SignInProblem>(null);
  const [failure, setFailure] = useState('');

  const handoff = useCallback(async () => {
    try {
      const { code } = await api.desktopHandoff(`${navigator.platform || 'desktop'}`);
      const target = new URL(`http://127.0.0.1:${port}/callback`);
      target.searchParams.set('code', code);
      target.searchParams.set('state', state);
      window.location.replace(target.toString());
      setPhase('done');
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) {
        setProblem(null);
        setPhase('sign-in');
        return;
      }
      if (e instanceof ApiError && e.status === 403) {
        setProblem({ kind: 'no-workspace' });
        setPhase('sign-in');
        return;
      }
      setFailure(e instanceof Error ? e.message : 'The console could not be reached.');
      setPhase('failed');
    }
  }, [port, state]);

  useEffect(() => {
    // Deferred a tick: the first attempt is a network round trip, not a render-time state change.
    const t = setTimeout(() => void handoff(), 0);
    return () => clearTimeout(t);
  }, [handoff]);

  const shell = (children: ReactNode) => (
    <div style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'var(--bg)', color: 'var(--tx)', fontFamily: "'DM Sans', sans-serif", padding: 24 }}>
      <div style={{ width: 380, maxWidth: '100%', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 22 }}>
        <Wordmark size={22} />
        {children}
      </div>
    </div>
  );

  if (!Number.isInteger(port) || port <= 0 || !state) {
    return shell(<p style={{ margin: 0, fontSize: 14, color: 'var(--tx2)', textAlign: 'center', lineHeight: 1.5 }}>This page is opened by the Cometloop desktop app. Start the sign-in from there.</p>);
  }
  if (phase === 'checking' || phase === 'handing-off') {
    return shell(<p style={{ margin: 0, fontSize: 14, color: 'var(--tx2)' }}>{phase === 'checking' ? 'One moment…' : 'Returning to the app…'}</p>);
  }
  if (phase === 'done') {
    return shell(
      <div style={{ textAlign: 'center', display: 'grid', gap: 8 }}>
        <div style={{ fontSize: 18, fontWeight: 600 }}>You’re signed in</div>
        <p style={{ margin: 0, fontSize: 14, color: 'var(--tx2)', lineHeight: 1.5 }}>You can close this tab and go back to Cometloop.</p>
      </div>,
    );
  }
  if (phase === 'failed') {
    return shell(
      <div style={{ textAlign: 'center', display: 'grid', gap: 10 }}>
        <div style={{ fontSize: 18, fontWeight: 600 }}>Something went wrong</div>
        <p style={{ margin: 0, fontSize: 14, color: 'var(--bad)', lineHeight: 1.5 }}>{failure}</p>
        <button onClick={() => void handoff()} style={{ fontFamily: 'inherit', fontSize: 14, fontWeight: 600, background: 'var(--acc)', color: '#fff', border: 'none', borderRadius: 4, padding: '10px 14px', cursor: 'pointer' }}>
          Try again
        </button>
      </div>,
    );
  }
  return shell(
    <>
      <div style={{ textAlign: 'center', display: 'grid', gap: 6 }}>
        <div style={{ fontSize: 18, fontWeight: 600 }}>Sign in to the desktop app</div>
        <p style={{ margin: 0, fontSize: 14, color: 'var(--tx2)', lineHeight: 1.5 }}>Sign in here and you’ll be sent back to Cometloop on this computer.</p>
      </div>
      <SignIn
        problem={problem}
        callbackURL={window.location.href}
        onSignedIn={() => {
          resetAccessToken();
          setPhase('handing-off');
          void handoff();
        }}
      />
    </>,
  );
}
