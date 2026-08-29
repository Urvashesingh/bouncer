/**
 * Monotonic clock shim.
 *
 * core has zero runtime dependencies and must run in Node, the browser, and
 * workers alike (SPEC §1, §11), so we reach for `performance.now()` without
 * assuming @types/node or DOM libs are present.
 */

interface PerformanceLike {
  now(): number;
}

const perf: PerformanceLike | undefined = (
  globalThis as unknown as { performance?: PerformanceLike }
).performance;

/** High-resolution monotonic timestamp in milliseconds. */
export function now(): number {
  return perf !== undefined ? perf.now() : Date.now();
}

/**
 * Timer and abort primitives.
 *
 * Declared structurally for the same reason as `performance`: they exist in
 * Node, browsers and workers, but not in the ES2022 lib, and core deliberately
 * pulls in neither @types/node nor the DOM lib (SPEC §1).
 */
interface TimerGlobals {
  setTimeout(handler: () => void, timeout: number): unknown;
  clearTimeout(handle: unknown): void;
  AbortController: new () => AbortControllerLike;
}

export interface AbortControllerLike {
  readonly signal: AbortSignalLike;
  abort(): void;
}

export interface AbortSignalLike {
  readonly aborted: boolean;
}

const timers = globalThis as unknown as TimerGlobals;

export function setTimer(handler: () => void, timeoutMs: number): unknown {
  return timers.setTimeout(handler, timeoutMs);
}

export function clearTimer(handle: unknown): void {
  timers.clearTimeout(handle);
}

export function createAbortController(): AbortControllerLike {
  return new timers.AbortController();
}
