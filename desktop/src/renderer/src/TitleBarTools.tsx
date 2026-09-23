import { useCallback, useEffect, useRef, useState, type CSSProperties } from 'react';
import { Bell, Moon, ShieldAlert, Sun } from 'lucide-react';

// Console client conventions: inline styles + theme tokens + mono() — see
// docs/development-standards.md "Client code". mono() mirrors client/src/util.ts.
const mono = (weight: number, size: number): CSSProperties => ({
  fontFamily: "'DM Mono', monospace",
  fontWeight: weight,
  fontSize: size,
});

export type Theme = 'dark' | 'light';

/** Icon-only title-bar button: 28px square, tooltip carries the label. */
const iconBtn = (active = false): CSSProperties => ({
  width: 28,
  height: 24,
  padding: 0,
  border: 'none',
  borderRadius: 4,
  background: active ? 'var(--bg3)' : 'transparent',
  color: active ? 'var(--tx)' : 'var(--tx2)',
  cursor: 'pointer',
  display: 'grid',
  placeItems: 'center',
  position: 'relative',
});

/**
 * The affordances the web top bar carried before the desktop hid it: theme
 * toggle, notification bell and the role-unverified retry chip. They live in
 * the title bar (right side, before the window controls) as icons only.
 */
export function TitleBarTools({
  theme,
  onToggleTheme,
  onOpenTicket,
}: {
  theme: Theme;
  onToggleTheme: () => void;
  /** Routes the embedded console to the ticket a notification points at. */
  onOpenTicket: (key: string) => void;
}) {
  return (
    <div className="no-drag" style={{ display: 'flex', alignItems: 'center', gap: 2, marginRight: 6 }}>
      <RoleChip />
      <NotificationBell onOpenTicket={onOpenTicket} />
      <button
        title={theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme'}
        aria-label={theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme'}
        onClick={onToggleTheme}
        style={iconBtn()}
      >
        {theme === 'dark' ? <Sun size={14} strokeWidth={1.75} /> : <Moon size={14} strokeWidth={1.75} />}
      </button>
    </div>
  );
}

/**
 * Shown only when the console could not say who you are (a non-401 failure
 * of /api/me): admin/lead actions inside the console hide until it can.
 * Click retries the lookup. Never shown while signed out — sign-in has its
 * own screen.
 */
function RoleChip() {
  const [failed, setFailed] = useState(false);
  const [busy, setBusy] = useState(false);
  const check = useCallback(() => {
    setBusy(true);
    void window.desktopBridge
      .consoleMe()
      .then((r) => setFailed(!r.ok && !r.signInRequired))
      .catch(() => setFailed(true))
      .finally(() => setBusy(false));
  }, []);
  useEffect(check, [check]);
  if (!failed) return null;
  return (
    <button
      title="Your role couldn't be verified, so admin/lead actions are hidden. Click to retry."
      aria-label="Role unverified — retry"
      onClick={check}
      disabled={busy}
      style={{ ...iconBtn(), color: 'var(--warn)', cursor: busy ? 'wait' : 'pointer' }}
    >
      <ShieldAlert size={14} strokeWidth={1.75} />
    </button>
  );
}

const POLL_MS = 30_000;

/**
 * The web bar's NotificationCenter, driven by the same /api/notifications
 * through the main process (the renderer never talks to the network). Polled
 * every 30s and on window focus instead of the web's SSE stream, which the
 * bridge does not carry; opening the dropdown refreshes too.
 */
function NotificationBell({ onOpenTicket }: { onOpenTicket: (key: string) => void }) {
  const [items, setItems] = useState<NotificationRow[]>([]);
  const [unread, setUnread] = useState(0);
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);

  const load = useCallback(() => {
    void window.desktopBridge
      .consoleNotifications()
      .then((r) => {
        if (!r.ok) return; // signed out or unreachable — the bell just shows no count
        setItems(r.notifications);
        setUnread(r.unread);
      })
      .catch(() => undefined);
  }, []);

  useEffect(() => {
    load();
    const t = setInterval(load, POLL_MS);
    window.addEventListener('focus', load);
    return () => {
      clearInterval(t);
      window.removeEventListener('focus', load);
    };
  }, [load]);

  useEffect(() => {
    if (!open) return;
    load();
    const close = (event: MouseEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, [open, load]);

  const read = (id: number) => {
    if (items.some((item) => item.id === id && !item.read)) setUnread((count) => Math.max(0, count - 1));
    setItems((current) => current.map((item) => (item.id === id ? { ...item, read: true } : item)));
    void window.desktopBridge.consoleNotificationRead(id).then((r) => (r.ok ? undefined : load()));
  };
  const visit = (item: NotificationRow) => {
    read(item.id);
    setOpen(false);
    if (item.ticketKey) onOpenTicket(item.ticketKey);
  };

  return (
    <div ref={root} style={{ position: 'relative' }}>
      <button
        title={unread ? `Notifications — ${unread} unread` : 'Notifications'}
        aria-label={`Notifications${unread ? `, ${unread} unread` : ''}`}
        onClick={() => setOpen((v) => !v)}
        style={iconBtn(open)}
      >
        <Bell size={14} strokeWidth={1.75} />
        {unread > 0 && (
          <span
            style={{
              position: 'absolute',
              top: 1,
              right: 1,
              minWidth: 14,
              height: 14,
              padding: '0 3px',
              display: 'grid',
              placeItems: 'center',
              borderRadius: 7,
              background: 'var(--acc)',
              color: 'var(--bg)',
              ...mono(700, 8.5),
            }}
          >
            {unread > 99 ? '99+' : unread}
          </span>
        )}
      </button>
      {open && (
        <div
          style={{
            position: 'absolute',
            top: 30,
            right: 0,
            width: 380,
            maxHeight: 480,
            overflow: 'auto',
            zIndex: 80,
            background: 'var(--bg2)',
            border: '1px solid var(--line2)',
            borderRadius: 5,
            boxShadow: '0 16px 50px rgba(0,0,0,.45)',
            userSelect: 'text',
          }}
        >
          <div
            style={{
              position: 'sticky',
              top: 0,
              display: 'flex',
              alignItems: 'center',
              padding: '12px 14px',
              background: 'var(--bg2)',
              borderBottom: '1px solid var(--line)',
            }}
          >
            <strong style={{ fontSize: 13 }}>Notifications</strong>
            <span style={{ flex: 1 }} />
            {unread > 0 && (
              <button
                onClick={() => {
                  setItems((current) => current.map((item) => ({ ...item, read: true })));
                  setUnread(0);
                  void window.desktopBridge.consoleNotificationsReadAll().then((r) => (r.ok ? undefined : load()));
                }}
                style={{ border: 0, background: 'none', color: 'var(--acc)', cursor: 'pointer', ...mono(500, 10) }}
              >
                MARK ALL READ
              </button>
            )}
          </div>
          {items.length === 0 ? (
            <div style={{ padding: 28, textAlign: 'center', color: 'var(--tx3)', fontSize: 12 }}>You’re all caught up.</div>
          ) : (
            items.map((item) => (
              <button
                key={item.id}
                onClick={() => visit(item)}
                style={{
                  width: '100%',
                  padding: '12px 14px',
                  textAlign: 'left',
                  display: 'flex',
                  justifyContent: 'flex-start',
                  gap: 10,
                  border: 0,
                  borderBottom: '1px solid var(--line)',
                  background: item.read ? 'transparent' : 'var(--accsoft)',
                  color: 'var(--tx)',
                  cursor: item.ticketKey ? 'pointer' : 'default',
                  fontFamily: 'inherit',
                }}
              >
                <span
                  style={{
                    marginTop: 5,
                    width: 6,
                    height: 6,
                    borderRadius: '50%',
                    background: item.read ? 'transparent' : 'var(--acc)',
                    flex: '0 0 auto',
                  }}
                />
                <span>
                  <span style={{ display: 'block', fontSize: 12.5, fontWeight: item.read ? 500 : 700 }}>{item.title}</span>
                  <span style={{ display: 'block', marginTop: 3, color: 'var(--tx2)', fontSize: 11.5, lineHeight: 1.4 }}>
                    {item.message}
                  </span>
                  <span style={{ display: 'block', marginTop: 5, color: 'var(--tx3)', ...mono(400, 9) }}>
                    {new Date(item.createdAt).toLocaleString()}
                  </span>
                </span>
              </button>
            ))
          )}
        </div>
      )}
    </div>
  );
}
