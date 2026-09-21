import { describe, expect, it, vi } from 'vitest';
import { retryableLazy, withRetry } from '../client/src/lib/lazy-retry';

const noSleep = () => Promise.resolve();

describe('retryableLazy', () => {
  it('loads once and shares the result', async () => {
    const load = vi.fn(() => Promise.resolve('lib'));
    const get = retryableLazy(load);
    expect(await Promise.all([get(), get()])).toEqual(['lib', 'lib']);
    expect(load).toHaveBeenCalledTimes(1);
  });

  it('forgets a failure so the next call loads again', async () => {
    const load = vi.fn<() => Promise<string>>().mockRejectedValueOnce(new Error('302 to sign-in')).mockResolvedValueOnce('lib');
    const get = retryableLazy(load);
    await expect(get()).rejects.toThrow('302');
    expect(await get()).toBe('lib');
    expect(await get()).toBe('lib');
    expect(load).toHaveBeenCalledTimes(2);
  });

  it('shares one in-flight attempt between concurrent callers, even a failing one', async () => {
    const load = vi.fn(() => Promise.reject(new Error('down')));
    const get = retryableLazy(load);
    const results = await Promise.allSettled([get(), get()]);
    expect(results.every((r) => r.status === 'rejected')).toBe(true);
    expect(load).toHaveBeenCalledTimes(1);
  });
});

describe('withRetry', () => {
  it('returns the first success without waiting', async () => {
    const sleep = vi.fn(noSleep);
    expect(await withRetry(() => Promise.resolve(1), { sleep })).toBe(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it('retries with a doubling delay and then succeeds', async () => {
    const sleep = vi.fn(noSleep);
    const op = vi.fn<() => Promise<string>>().mockRejectedValueOnce(new Error('a')).mockRejectedValueOnce(new Error('b')).mockResolvedValueOnce('ok');
    expect(await withRetry(op, { tries: 3, delayMs: 100, sleep })).toBe('ok');
    expect(sleep.mock.calls.map((c) => c[0])).toEqual([100, 200]);
  });

  it('gives up after the last attempt with the last error', async () => {
    const op = vi.fn(() => Promise.reject(new Error('still down')));
    await expect(withRetry(op, { tries: 2, delayMs: 1, sleep: noSleep })).rejects.toThrow('still down');
    expect(op).toHaveBeenCalledTimes(2);
  });
});
