import { useCallback, useEffect, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { Bell, X } from 'lucide-react';
import { api } from '../api';
import type { Notification } from '../types';
import { mono } from '../util';

const AUTO_DISMISS_MS = 6000;

/** Row values are `unknown`; coerce through a typed helper, never bare String(). */
const txt = (v: unknown): string => (typeof v === 'string' ? v : typeof v === 'number' || typeof v === 'boolean' ? String(v) : '');

function fromRow(row: Record<string, unknown>): Notification {
  return {
    id: Number(row.id),
    type: txt(row.type),
    title: txt(row.title),
    message: txt(row.message),
    ticketKey: row.ticket_key == null ? null : txt(row.ticket_key),
    engagementId: row.engagement_id == null ? null : txt(row.engagement_id),
    read: row.read === true,
    createdAt: txt(row.created_at) || new Date().toISOString(),
  };
}

export function NotificationCenter({ onOpenTicket }: { onOpenTicket: (key: string) => void }) {
  const [items, setItems] = useState<Notification[]>([]);
  const [unread, setUnread] = useState(0);
  const [open, setOpen] = useState(false);
  const [toasts, setToasts] = useState<Notification[]>([]);
  const root = useRef<HTMLDivElement>(null);
  const load = useCallback(
    () =>
      void api
        .notifications()
        .then((data) => {
          setItems(data.notifications);
          setUnread(data.unread);
        })
        .catch(() => undefined),
    []
  );
  useEffect(load, [load]);

  useEffect(() => {
    const events = new EventSource('/api/notifications/stream');
    events.onmessage = (event) => {
      // event.data is `any` off the EventSource type — narrow before parsing.
      const payload: unknown = event.data;
      const raw: unknown = typeof payload === 'string' ? (JSON.parse(payload) as unknown) : {};
      const notification = fromRow((raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>);
      setItems((current) => [notification, ...current.filter((item) => item.id !== notification.id)]);
      setUnread((count) => count + 1);
      setToasts((current) => [...current, notification]);
      setTimeout(() => setToasts((current) => current.filter((item) => item.id !== notification.id)), AUTO_DISMISS_MS);
    };
    return () => events.close();
  }, []);

  useEffect(() => {
    const close = (event: MouseEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, []);

  const read = (id: number) => {
    if (items.some((item) => item.id === id && !item.read)) setUnread((count) => Math.max(0, count - 1));
    setItems((current) => current.map((item) => (item.id === id ? { ...item, read: true } : item)));
    void api.markNotificationRead(id).catch(load);
  };
  const visit = (item: Notification) => {
    read(item.id);
    setToasts((current) => current.filter((toast) => toast.id !== item.id));
    setOpen(false);
    if (item.ticketKey) onOpenTicket(item.ticketKey);
  };

  return (
    <>
      <div ref={root} style={{ position: 'relative' }}>
        <button
          aria-label={`Notifications${unread ? `, ${unread} unread` : ''}`}
          onClick={() => setOpen((value) => !value)}
          style={{
            position: 'relative',
            display: 'grid',
            placeItems: 'center',
            width: 30,
            height: 30,
            padding: 0,
            background: 'none',
            color: 'var(--tx2)',
            border: '1px solid var(--line2)',
            borderRadius: 3,
            cursor: 'pointer',
          }}
        >
          <Bell size={15} />
          {unread > 0 && (
            <span
              style={{
                position: 'absolute',
                top: -6,
                right: -7,
                minWidth: 17,
                height: 17,
                padding: '0 4px',
                display: 'grid',
                placeItems: 'center',
                borderRadius: 9,
                background: 'var(--acc)',
                color: 'var(--bg)',
                ...mono(700, 9),
              }}
            >
              {unread > 99 ? '99+' : unread}
            </span>
          )}
        </button>
        <AnimatePresence>
          {open && (
            <motion.div
              initial={{ opacity: 0, y: -5, scale: 0.98 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, y: -4, scale: 0.98 }}
              style={{
                position: 'absolute',
                top: 38,
                right: 0,
                width: 380,
                maxWidth: 'calc(100vw - 24px)',
                maxHeight: 480,
                overflow: 'auto',
                zIndex: 80,
                background: 'var(--bg2)',
                border: '1px solid var(--line2)',
                borderRadius: 5,
                boxShadow: '0 16px 50px rgba(0,0,0,.45)',
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
                      void api.markAllNotificationsRead().catch(load);
                    }}
                    style={{ border: 0, background: 'none', color: 'var(--acc)', cursor: 'pointer', ...mono(500, 10) }}
                  >
                    MARK ALL READ
                  </button>
                )}
              </div>
              {items.length === 0 ? (
                <div style={{ padding: 28, textAlign: 'center', color: 'var(--tx3)', fontSize: 12 }}>
                  You’re all caught up.
                </div>
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
                      gap: 10,
                      border: 0,
                      borderBottom: '1px solid var(--line)',
                      background: item.read ? 'transparent' : 'var(--accsoft)',
                      color: 'var(--tx)',
                      cursor: item.ticketKey ? 'pointer' : 'default',
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
                      <span style={{ display: 'block', fontSize: 12.5, fontWeight: item.read ? 500 : 700 }}>
                        {item.title}
                      </span>
                      <span
                        style={{ display: 'block', marginTop: 3, color: 'var(--tx2)', fontSize: 11.5, lineHeight: 1.4 }}
                      >
                        {item.message}
                      </span>
                      <span style={{ display: 'block', marginTop: 5, color: 'var(--tx3)', ...mono(400, 9) }}>
                        {new Date(item.createdAt).toLocaleString()}
                      </span>
                    </span>
                  </button>
                ))
              )}
            </motion.div>
          )}
        </AnimatePresence>
      </div>
      <div
        aria-live="polite"
        style={{
          position: 'fixed',
          right: 20,
          bottom: 20,
          zIndex: 100,
          display: 'flex',
          flexDirection: 'column',
          gap: 9,
          width: 350,
          maxWidth: 'calc(100vw - 40px)',
        }}
      >
        <AnimatePresence>
          {toasts.map((item) => (
            <motion.div
              key={item.id}
              initial={{ opacity: 0, x: 35, scale: 0.96 }}
              animate={{ opacity: 1, x: 0, scale: 1 }}
              exit={{ opacity: 0, x: 25, scale: 0.96 }}
              transition={{ type: 'spring', visualDuration: 0.3, bounce: 0.18 }}
              onClick={() => visit(item)}
              style={{
                padding: '13px 38px 13px 14px',
                position: 'relative',
                background: 'var(--bg3)',
                color: 'var(--tx)',
                border: '1px solid var(--line2)',
                borderRadius: 5,
                boxShadow: '0 12px 35px rgba(0,0,0,.42)',
                cursor: item.ticketKey ? 'pointer' : 'default',
              }}
            >
              <strong style={{ display: 'block', fontSize: 12.5 }}>{item.title}</strong>
              <span style={{ display: 'block', marginTop: 4, color: 'var(--tx2)', fontSize: 11.5 }}>
                {item.message}
              </span>
              <button
                aria-label="Dismiss notification"
                onClick={(event) => {
                  event.stopPropagation();
                  setToasts((current) => current.filter((toast) => toast.id !== item.id));
                }}
                style={{
                  position: 'absolute',
                  right: 8,
                  top: 8,
                  border: 0,
                  padding: 4,
                  background: 'none',
                  color: 'var(--tx3)',
                  cursor: 'pointer',
                }}
              >
                <X size={14} />
              </button>
            </motion.div>
          ))}
        </AnimatePresence>
      </div>
    </>
  );
}
