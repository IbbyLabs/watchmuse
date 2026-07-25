import { createLogger } from '../logger.js';
import { providerObserver } from './observer.js';

const log = createLogger('http');

export interface HttpOptions {
  baseUrl: string;
  headers?: Record<string, string>;
  /** Query params added to every request unless already present (e.g. Simkl app-name). */
  defaultQuery?: Record<string, string>;
  /** Minimum spacing between requests, ms (e.g. Trakt writes = 1/sec). */
  minIntervalMs?: number;
  /**
   * How many requests may be in flight at once. Defaults to 1, which keeps
   * strictly ordered upstreams (Trakt writes) behaving exactly as before. Raise
   * it for read-only upstreams where latency, not the rate limit, is the ceiling.
   */
  maxConcurrent?: number;
  /**
   * Follow 3xx responses. Off for upstreams the user names, where a permitted
   * host could otherwise bounce the request somewhere it was not allowed to go.
   */
  followRedirects?: boolean;
  /**
   * Share this client's pacing with every other client using the same key.
   *
   * Rate limits are enforced against a credential, not a connection. Trakt and
   * Simkl see one API key for the whole deployment, but a client is built per
   * user per operation, so without this each one paces as though it were the
   * only caller and the app's real request rate is however many rebuilds happen
   * to overlap. Keying pacing to the credential makes `minIntervalMs` mean what
   * it says process-wide. Leave unset for per-user upstreams.
   */
  rateLimitKey?: string;
  /**
   * Provider name for metrics, e.g. 'tmdb'. Must be a stable, low-cardinality
   * label — never a credential or a per-user value, since it is published on
   * the metrics endpoint. Omit to record nothing for this client.
   */
  provider?: string;
  /** Max retries on 429 / 5xx. */
  maxRetries?: number;
  /** Bounds the backoff wait honoured from Retry-After, ms. */
  maxBackoffMs?: number;
  timeoutMs?: number;
}

export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly body: string,
    readonly url: string,
  ) {
    super(`HTTP ${status} for ${url}`);
    this.name = 'HttpError';
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * A small fetch wrapper that paces requests, retries on 429/5xx honouring
 * `Retry-After`, and throws `HttpError` on non-2xx. One instance per provider
 * connection so pacing is isolated per upstream.
 */
/** Next free send slot per rate-limit key, shared by every client using it. */
const sharedSlots = new Map<string, number>();

export class HttpClient {
  private readonly opts: Required<HttpOptions>;
  private nextSlotAt = 0;
  private inFlight = 0;
  private readonly waiting: Array<() => void> = [];

  constructor(options: HttpOptions) {
    this.opts = {
      headers: {},
      defaultQuery: {},
      minIntervalMs: 0,
      maxConcurrent: 1,
      followRedirects: true,
      rateLimitKey: '',
      provider: '',
      maxRetries: 4,
      maxBackoffMs: 60_000,
      timeoutMs: 20_000,
      ...options,
    };
  }

  get<T>(path: string, init?: RequestInit): Promise<T> {
    return this.request<T>('GET', path, undefined, init);
  }

  /** GET a response that is not JSON (an RSS feed, say), returned verbatim. */
  getText(path: string, init?: RequestInit): Promise<string> {
    return this.request<string>('GET', path, undefined, init, 'text');
  }

  post<T>(path: string, body?: unknown, init?: RequestInit): Promise<T> {
    return this.request<T>('POST', path, body, init);
  }

  delete<T>(path: string, init?: RequestInit): Promise<T> {
    return this.request<T>('DELETE', path, undefined, init);
  }

  private async request<T>(
    method: string,
    path: string,
    body?: unknown,
    init?: RequestInit,
    as: 'json' | 'text' = 'json',
  ): Promise<T> {
    await this.acquire();
    const watcher = this.opts.provider ? providerObserver() : null;
    const provider = this.opts.provider ?? '';
    watcher?.onStart(provider);
    try {
      await this.pace();
      const result = await this.execute<T>(method, path, body, init, as);
      watcher?.onEnd(provider, 'ok');
      return result;
    } catch (err) {
      watcher?.onEnd(provider, 'error');
      throw err;
    } finally {
      this.release();
    }
  }

  private acquire(): Promise<void> {
    if (this.inFlight < this.opts.maxConcurrent) {
      this.inFlight++;
      return Promise.resolve();
    }
    // FIFO, so a burst of requests still goes out in the order it was queued.
    return new Promise((resolve) => this.waiting.push(resolve));
  }

  private release(): void {
    const next = this.waiting.shift();
    if (next) next();
    else this.inFlight--;
  }

  /**
   * Claim the next send slot. Slots are handed out as advancing reservations
   * rather than measured against the last completed call, so spacing holds even
   * when several requests are in flight at once.
   */
  private async pace(): Promise<void> {
    if (this.opts.minIntervalMs <= 0) return;
    const key = this.opts.rateLimitKey;
    const now = Date.now();
    const at = Math.max(now, key ? (sharedSlots.get(key) ?? 0) : this.nextSlotAt);
    const next = at + this.opts.minIntervalMs;
    if (key) sharedSlots.set(key, next);
    else this.nextSlotAt = next;
    if (at > now) await sleep(at - now);
  }

  private async execute<T>(
    method: string,
    path: string,
    body?: unknown,
    init?: RequestInit,
    as: 'json' | 'text' = 'json',
  ): Promise<T> {
    let url = path.startsWith('http') ? path : `${this.opts.baseUrl}${path}`;
    const defaults = Object.entries(this.opts.defaultQuery);
    if (defaults.length > 0) {
      const u = new URL(url);
      for (const [k, v] of defaults) if (!u.searchParams.has(k)) u.searchParams.set(k, v);
      url = u.toString();
    }
    let attempt = 0;

    for (;;) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.opts.timeoutMs);
      let res: Response;
      try {
        res = await fetch(url, {
          method,
          headers: {
            ...this.opts.headers,
            ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
            ...(init?.headers as Record<string, string> | undefined),
          },
          body: body !== undefined ? JSON.stringify(body) : undefined,
          redirect: this.opts.followRedirects ? 'follow' : 'manual',
          signal: controller.signal,
        });
      } finally {
        clearTimeout(timer);
      }

      if (res.status === 429 || res.status >= 500) {
        if (attempt < this.opts.maxRetries) {
          const wait = this.backoff(res, attempt);
          log.warn({ url, status: res.status, attempt, wait }, 'Retrying after backoff');
          await sleep(wait);
          attempt++;
          continue;
        }
      }

      if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new HttpError(res.status, text, url);
      }

      if (res.status === 204) return undefined as T;
      const text = await res.text();
      if (as === 'text') return text as T;
      return (text ? JSON.parse(text) : undefined) as T;
    }
  }

  private backoff(res: Response, attempt: number): number {
    const retryAfter = res.headers.get('retry-after');
    if (retryAfter) {
      const secs = Number(retryAfter);
      if (Number.isFinite(secs)) return Math.min(secs * 1000, this.opts.maxBackoffMs);
    }
    const base = Math.min(2 ** attempt * 1000, this.opts.maxBackoffMs);
    return base + Math.floor(Math.random() * 250); // jitter
  }
}
