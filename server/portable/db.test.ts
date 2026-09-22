import { describe, expect, it } from 'vitest';
import { portablePoolConfig } from './db';

describe('portablePoolConfig', () => {
  it('verifies certificates by default and strips sslmode from the URL pg sees', () => {
    const cfg = portablePoolConfig('postgresql://app:secret@ep-x.neon.tech/neondb?sslmode=require&channel_binding=require');
    expect(cfg.ssl).toEqual({ rejectUnauthorized: true });
    expect(cfg.connectionString).not.toContain('sslmode');
    expect(cfg.connectionString).toContain('channel_binding=require');
    expect(cfg.label).toBe('ep-x.neon.tech/neondb');
    expect(cfg.label).not.toContain('secret');
  });

  it('turns SSL off only when the URL says so (docker-compose Postgres)', () => {
    expect(portablePoolConfig('postgres://app:app@postgres:5432/app?sslmode=disable').ssl).toBe(false);
    expect(portablePoolConfig('postgres://app:app@postgres:5432/app').ssl).toEqual({ rejectUnauthorized: true });
  });

  it('keeps encryption but skips verification for no-verify', () => {
    expect(portablePoolConfig('postgres://a:b@h/db?sslmode=no-verify').ssl).toEqual({ rejectUnauthorized: false });
  });
});
