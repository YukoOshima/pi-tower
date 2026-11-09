import { afterEach, describe, expect, it, vi } from 'vitest';

import { systemClock } from '../../src/headless/cli.ts';
import { boundedDelay, MAX_DELAY_MS } from '../../src/headless/timers.ts';

afterEach(() => {
  vi.useRealTimers();
});

describe('systemClock.sleep', () => {
  it('waits past the 2147483647 ms timer limit in chunks instead of firing at once', async () => {
    vi.useFakeTimers();
    let done = false;
    void systemClock.sleep(3_000_000_000, new AbortController().signal).then(() => {
      done = true;
    });
    await vi.advanceTimersByTimeAsync(MAX_DELAY_MS);
    expect(done).toBe(false);
    await vi.advanceTimersByTimeAsync(3_000_000_000 - MAX_DELAY_MS - 1);
    expect(done).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(done).toBe(true);
  });

  it('resolves at once when aborted, before or during the wait', async () => {
    vi.useFakeTimers();
    const aborted = new AbortController();
    aborted.abort();
    await systemClock.sleep(60_000, aborted.signal);
    const later = new AbortController();
    let done = false;
    void systemClock.sleep(60_000, later.signal).then(() => {
      done = true;
    });
    await vi.advanceTimersByTimeAsync(10);
    later.abort();
    await vi.advanceTimersByTimeAsync(0);
    expect(done).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('boundedDelay', () => {
  it('keeps every timer delay inside what setTimeout accepts', () => {
    expect(boundedDelay(-5)).toBe(0);
    expect(boundedDelay(1500)).toBe(1500);
    expect(boundedDelay(3_000_000_000)).toBe(MAX_DELAY_MS);
  });
});
