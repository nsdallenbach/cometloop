import { mono } from '../util';

/**
 * Cross-project metrics (/metrics). This is a placeholder so the route and
 * the nav entry exist; the metrics branch replaces this component with the
 * real page. Keep the export name — App.tsx and the desktop sidebar route here.
 */
export function Metrics() {
  return (
    <div style={{ flex: 1, overflow: 'auto', padding: '20px 22px 40px' }}>
      <h1 style={{ margin: '0 0 6px', fontSize: 19, fontWeight: 600, letterSpacing: '-.01em' }}>Metrics</h1>
      <p style={{ margin: 0, fontSize: 12.5, color: 'var(--tx2)', maxWidth: 520, lineHeight: 1.5 }}>
        Token usage, cost and throughput across every project and agent.
      </p>
      <div
        style={{
          ...mono(500, 10),
          display: 'inline-block',
          marginTop: 14,
          color: 'var(--agent)',
          border: '1px solid var(--agent)',
          borderRadius: 3,
          padding: '2px 7px',
          letterSpacing: '.06em',
        }}
      >
        COMING SOON
      </div>
    </div>
  );
}
