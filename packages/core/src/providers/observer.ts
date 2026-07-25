/**
 * A seam for instrumenting outbound provider calls.
 *
 * Core has no business importing a metrics library — it is used by the CLI and
 * by tests as well as the server — so it publishes events and lets whoever
 * cares subscribe. Nothing is recorded when no observer is set, which is the
 * default everywhere except a running server.
 */

export interface ProviderObserver {
  /** A request to `provider` is about to go out. */
  onStart(provider: string): void;
  /** That request finished. `outcome` is 'ok' for 2xx, 'error' otherwise. */
  onEnd(provider: string, outcome: 'ok' | 'error'): void;
}

let observer: ProviderObserver | null = null;

export function setProviderObserver(next: ProviderObserver | null): void {
  observer = next;
}

export function providerObserver(): ProviderObserver | null {
  return observer;
}
