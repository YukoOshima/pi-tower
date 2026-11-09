export interface MissionTimers {
  now(): number;
  setTimeout(callback: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
  setInterval(callback: () => void, ms: number): unknown;
  clearInterval(handle: unknown): void;
}

export const DEFAULT_MISSION_TIMERS: MissionTimers = {
  now: () => Date.now(),
  setTimeout: (callback, ms) => unref(setTimeout(callback, ms)),
  clearTimeout: (handle) => {
    clearTimeout(handle as NodeJS.Timeout);
  },
  setInterval: (callback, ms) => unref(setInterval(callback, ms)),
  clearInterval: (handle) => {
    clearInterval(handle as NodeJS.Timeout);
  },
};

export interface MissionRefresherOptions {
  readonly refresh: () => Promise<void>;
  readonly timers: MissionTimers;
  readonly throttleMs: number;
  readonly tickMs: number;
  readonly onError?: (error: unknown) => void;
}

export class MissionRefresher {
  private readonly options: MissionRefresherOptions;
  private interval: unknown;
  private trailing: unknown;
  private running = false;
  private inFlight = false;
  private dirty = false;
  private lastRunAt = Number.NEGATIVE_INFINITY;

  constructor(options: MissionRefresherOptions) {
    this.options = options;
  }

  get started(): boolean {
    return this.running;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.interval = this.options.timers.setInterval(() => {
      this.request();
    }, this.options.tickMs);
  }

  stop(): void {
    this.running = false;
    this.dirty = false;
    if (this.interval !== undefined) {
      this.options.timers.clearInterval(this.interval);
      this.interval = undefined;
    }
    if (this.trailing !== undefined) {
      this.options.timers.clearTimeout(this.trailing);
      this.trailing = undefined;
    }
  }

  request(): void {
    if (!this.running) return;
    if (this.inFlight) {
      this.dirty = true;
      return;
    }
    if (this.trailing !== undefined) return;
    const wait = this.lastRunAt + this.options.throttleMs - this.options.timers.now();
    if (wait <= 0) {
      this.run();
      return;
    }
    this.trailing = this.options.timers.setTimeout(() => {
      this.trailing = undefined;
      if (this.running) this.run();
    }, wait);
  }

  private run(): void {
    this.inFlight = true;
    this.dirty = false;
    this.lastRunAt = this.options.timers.now();
    let pending: Promise<void>;
    try {
      pending = this.options.refresh();
    } catch (error) {
      pending = Promise.reject(error instanceof Error ? error : new Error(String(error)));
    }
    void pending
      .catch((error: unknown) => {
        try {
          this.options.onError?.(error);
        } catch {
          return;
        }
      })
      .finally(() => {
        this.inFlight = false;
        if (this.dirty && this.running) this.request();
      });
  }
}

function unref<T>(handle: T): T {
  (handle as { unref?: () => void }).unref?.();
  return handle;
}
