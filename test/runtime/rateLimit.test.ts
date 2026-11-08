import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  isRateLimitError,
  RATE_LIMIT_CAPACITY_RECOVERY_INTERVAL_MS,
  RATE_LIMIT_CAPACITY_SHRINK_INTERVAL_MS,
  RateLimitCapacityGovernor,
  TOWER_SPAWN_PAUSE_MS,
  TowerRateLimiter,
  type TowerRateLimitSnapshot,
} from '../../src/runtime/rateLimit.ts';

describe('TowerRateLimiter', () => {
  let now: number;
  let config: { maxRunningAgents?: number };
  let limiter: TowerRateLimiter;

  beforeEach(() => {
    now = 1_000_000;
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    config = {};
    limiter = new TowerRateLimiter({ maxRunningAgents: () => config.maxRunningAgents });
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  function snapshot(): TowerRateLimitSnapshot {
    return limiter.snapshot();
  }

  it('starts with a 256-agent budget and no pause', () => {
    expect(snapshot()).toEqual({
      budget: 256,
      inflight: 0,
      blockedUntil: null,
    });
  });

  it('refuses new spawns above the default budget', () => {
    for (let index = 0; index < 256; index += 1) {
      expect(limiter.acquire()).toEqual({ ok: true });
    }

    const gate = limiter.acquire();
    expect(gate.ok).toBe(false);
    if (gate.ok) throw new Error('expected acquire to be refused');
    expect(gate.reason).toContain('tower concurrency budget exhausted (256/256');
  });

  it('allows an explicit maxRunningAgents to exceed the default budget', () => {
    config.maxRunningAgents = 300;

    expect(snapshot().budget).toBe(300);
  });

  it('uses maxRunningAgents to limit the budget and new acquisitions', () => {
    config.maxRunningAgents = 2;

    expect(snapshot().budget).toBe(2);
    expect(limiter.acquire()).toEqual({ ok: true });
    expect(limiter.acquire()).toEqual({ ok: true });

    const gate = limiter.acquire();
    expect(gate.ok).toBe(false);
    if (gate.ok) throw new Error('expected acquire to be refused');
    expect(gate.reason).toContain('tower concurrency budget exhausted (2/2');
  });

  it('accepts a fixed maxRunningAgents number', () => {
    const fixed = new TowerRateLimiter({ maxRunningAgents: 3 });

    expect(fixed.snapshot().budget).toBe(3);
  });

  it('falls back to the default budget for non-positive or non-finite maxima', () => {
    for (const value of [0, -4, Number.NaN, Number.POSITIVE_INFINITY]) {
      config.maxRunningAgents = value;
      expect(limiter.budget()).toBe(256);
    }
  });

  it('re-reads maxRunningAgents when the configuration changes', () => {
    config.maxRunningAgents = 2;
    expect(limiter.budget()).toBe(2);

    config.maxRunningAgents = 4;
    expect(limiter.budget()).toBe(4);

    config.maxRunningAgents = undefined;
    expect(limiter.budget()).toBe(256);
  });

  it('acquire / release track inflight agents', () => {
    expect(limiter.acquire()).toEqual({ ok: true });
    expect(limiter.acquire()).toEqual({ ok: true });
    expect(snapshot().inflight).toBe(2);

    limiter.release();
    expect(snapshot().inflight).toBe(1);

    limiter.release();
    limiter.release();
    expect(snapshot().inflight).toBe(0);
  });

  it('anchors the budget to (inflight - 1) on the first 429 and pauses spawns', () => {
    expect(limiter.acquire().ok).toBe(true);
    expect(limiter.acquire().ok).toBe(true);
    expect(limiter.acquire().ok).toBe(true);

    limiter.reportRateLimited();

    expect(snapshot()).toEqual({
      budget: 2,
      inflight: 3,
      blockedUntil: now + TOWER_SPAWN_PAUSE_MS,
    });
  });

  it('refuses new spawns while the post-429 pause is in effect', () => {
    limiter.reportRateLimited();

    const gate = limiter.acquire();
    expect(gate.ok).toBe(false);
    if (gate.ok) throw new Error('expected acquire to be refused');
    expect(gate.reason).toContain('new tower spawns paused');

    now += TOWER_SPAWN_PAUSE_MS;
    expect(limiter.acquire()).toEqual({ ok: true });
  });

  it('lifts the spawn pause early once a request succeeds', () => {
    limiter.reportRateLimited();
    expect(snapshot().blockedUntil).not.toBeNull();

    limiter.reportSuccess();

    expect(snapshot().blockedUntil).toBeNull();
    expect(limiter.acquire()).toEqual({ ok: true });
  });

  it('refuses spawns when the inflight count reaches the budget', () => {
    expect(limiter.acquire().ok).toBe(true);

    limiter.reportRateLimited();
    now += TOWER_SPAWN_PAUSE_MS;

    const gate = limiter.acquire();
    expect(gate.ok).toBe(false);
    if (gate.ok) throw new Error('expected acquire to be refused');
    expect(gate.reason).toContain('tower concurrency budget exhausted (1/1');

    limiter.release();
    expect(limiter.acquire()).toEqual({ ok: true });
  });

  it('recovers capacity by one per quiet window without 429s', () => {
    expect(limiter.acquire().ok).toBe(true);
    expect(limiter.acquire().ok).toBe(true);
    limiter.reportRateLimited();
    expect(snapshot().budget).toBe(1);

    now += RATE_LIMIT_CAPACITY_RECOVERY_INTERVAL_MS;
    expect(limiter.budget()).toBe(2);

    now += RATE_LIMIT_CAPACITY_RECOVERY_INTERVAL_MS;
    expect(limiter.budget()).toBe(3);
  });

  it('combines 429 recovery with the configured maxRunningAgents cap', () => {
    config.maxRunningAgents = 3;
    expect(limiter.acquire().ok).toBe(true);
    expect(limiter.acquire().ok).toBe(true);
    expect(limiter.acquire().ok).toBe(true);
    limiter.reportRateLimited();
    expect(snapshot().budget).toBe(2);

    now += RATE_LIMIT_CAPACITY_RECOVERY_INTERVAL_MS;
    expect(limiter.budget()).toBe(3);

    now += RATE_LIMIT_CAPACITY_RECOVERY_INTERVAL_MS;
    expect(limiter.budget()).toBe(3);
  });

  it('reset restores the pristine state', () => {
    expect(limiter.acquire().ok).toBe(true);
    limiter.reportRateLimited();

    limiter.reset();

    expect(snapshot()).toEqual({
      budget: 256,
      inflight: 0,
      blockedUntil: null,
    });
  });

  it('uses an injected clock instead of Date.now when one is given', () => {
    let clock = 5_000;
    const clocked = new TowerRateLimiter({ now: () => clock });

    clocked.reportRateLimited();
    expect(clocked.snapshot().blockedUntil).toBe(5_000 + TOWER_SPAWN_PAUSE_MS);

    clock += TOWER_SPAWN_PAUSE_MS;
    expect(clocked.acquire()).toEqual({ ok: true });
  });
});

describe('RateLimitCapacityGovernor', () => {
  it('shrinks at most once per spacing window and never below one', () => {
    let now = 0;
    const governor = new RateLimitCapacityGovernor(() => now);

    governor.noteRateLimited(4);
    expect(governor.getCapacity()).toBe(3);

    now += RATE_LIMIT_CAPACITY_SHRINK_INTERVAL_MS - 1;
    governor.noteRateLimited(4);
    expect(governor.getCapacity()).toBe(3);

    now += 1;
    governor.noteRateLimited(4);
    expect(governor.getCapacity()).toBe(2);

    for (let index = 0; index < 5; index += 1) {
      now += RATE_LIMIT_CAPACITY_SHRINK_INTERVAL_MS;
      governor.noteRateLimited(4);
    }
    expect(governor.getCapacity()).toBe(1);
  });

  it('keeps unbounded capacity when a 429 arrives with nothing running', () => {
    let now = 10;
    const governor = new RateLimitCapacityGovernor(() => now);

    expect(governor.inBackoff).toBe(false);
    expect(governor.nextRecoveryAt()).toBe(Number.POSITIVE_INFINITY);

    governor.noteRateLimited(0);

    expect(governor.getCapacity()).toBe(Number.POSITIVE_INFINITY);
    expect(governor.inBackoff).toBe(true);
    expect(governor.lastRateLimitedAt).toBe(10);
    expect(governor.nextRecoveryAt()).toBe(10 + RATE_LIMIT_CAPACITY_RECOVERY_INTERVAL_MS);
    now += RATE_LIMIT_CAPACITY_RECOVERY_INTERVAL_MS;
    expect(governor.maybeRecover()).toBe(true);
  });

  it('recovers only after a full quiet window since the last 429 or recovery', () => {
    let now = 0;
    const governor = new RateLimitCapacityGovernor(() => now);
    governor.noteRateLimited(3);

    now += RATE_LIMIT_CAPACITY_RECOVERY_INTERVAL_MS - 1;
    expect(governor.maybeRecover()).toBe(false);
    expect(governor.getCapacity()).toBe(2);

    now += 1;
    expect(governor.maybeRecover()).toBe(true);
    expect(governor.maybeRecover()).toBe(false);
    expect(governor.getCapacity()).toBe(3);

    governor.reset();
    expect(governor.getCapacity()).toBe(Number.POSITIVE_INFINITY);
    expect(governor.inBackoff).toBe(false);
  });
});

describe('isRateLimitError', () => {
  it('recognizes provider rate-limit wording', () => {
    for (const message of [
      '429 Too Many Requests',
      '{"type":"error","error":{"type":"rate_limit_error","message":"slow down"}}',
      'Rate limit reached for requests',
      'too many requests, please retry later',
      'RESOURCE_EXHAUSTED: quota per minute',
      'ThrottlingException: Rate exceeded',
      'HTTP 429',
    ]) {
      expect(isRateLimitError(message), message).toBe(true);
    }
  });

  it('ignores aborts, overloads and numbers that merely contain 429', () => {
    for (const message of [
      'This operation was aborted',
      'overloaded_error: Overloaded',
      'request id req_4291ab failed',
      'context length 14290 exceeded',
      '',
      undefined,
    ]) {
      expect(isRateLimitError(message), String(message)).toBe(false);
    }
  });
});
