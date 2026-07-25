import { createLogger } from '../logger.js';
import { HttpClient } from './http.js';
import type { DeviceCode } from './trakt.js';
import type { ExternalIds, ProviderCapabilities, WatchEvent } from './types.js';

const log = createLogger('stremio');

const API_BASE = 'https://api.strem.io/api';
const LINK_BASE = 'https://link.stremio.com/api/v2';

/** The datastore collection holding a user's library. */
const LIBRARY_COLLECTION = 'libraryItem';

/**
 * The link code is short-lived. Stremio does not publish a lifetime, so this is
 * the window the UI polls for before telling the user to start again.
 */
const LINK_EXPIRES_IN = 300;
const LINK_POLL_INTERVAL = 3;

/** Stremio answers every call with either a result or an error, never both. */
interface ApiEnvelope<T> {
  result?: T;
  error?: { code: number; message: string };
}

interface LinkCode {
  code: string;
  link: string;
  qrcode: string;
}

interface LibraryItemState {
  /** How many times this has been watched; 0 means started but never finished. */
  timesWatched?: number;
  lastWatched?: string | null;
}

interface LibraryItem {
  _id: string;
  name?: string;
  type?: string;
  /** The user deleted it from their library. */
  removed?: boolean;
  /** Added implicitly by playing something, rather than deliberately saved. */
  temp?: boolean;
  state?: LibraryItemState;
}

export class StremioLinkPending extends Error {
  constructor() {
    super('Waiting for you to approve the code in Stremio');
    this.name = 'StremioLinkPending';
  }
}

export class StremioSessionInvalid extends Error {
  constructor() {
    super('Your Stremio session is no longer valid. Reconnect to continue syncing');
    this.name = 'StremioSessionInvalid';
  }
}

/**
 * Resolve an IMDb id to a TMDB id. Stremio's library is keyed by Stremio meta
 * ids, which for anything from Cinemeta are IMDb ids, and the rest of Watchmuse
 * works in TMDB space.
 */
export type ImdbResolver = (
  imdbId: string,
  type: 'movie' | 'series',
) => Promise<number | null>;

/**
 * The user's Stremio library as a read-only history source.
 *
 * This exists to remove the signup barrier: someone already running Stremio can
 * get recommendations without opening a Trakt or Simkl account. Pairing goes
 * through Stremio's own link flow, the same one their TV app uses — we hand the
 * user a short code, they approve it on stremio.com, and we receive a session
 * key. Watchmuse never sees their email or password, and asking for those
 * directly would read as a phishing attempt whatever the intent.
 */
export class StremioClient {
  readonly id = 'stremio' as const;
  private readonly http: HttpClient;

  constructor(
    private readonly authKey: string,
    private readonly resolveImdb?: ImdbResolver,
  ) {
    this.http = new HttpClient({
      provider: 'stremio',
      baseUrl: API_BASE,
      minIntervalMs: 200,
      headers: { 'user-agent': 'Watchmuse' },
    });
  }

  capabilities(): ProviderCapabilities {
    return { history: true, progress: true, ratings: false, watchlist: true, datedHistory: true };
  }

  /** Begin pairing: returns the code and the page the user approves it on. */
  static async startLink(): Promise<DeviceCode> {
    const http = new HttpClient({ provider: 'stremio', baseUrl: LINK_BASE });
    const res = await http.get<ApiEnvelope<LinkCode>>('/create?type=Create');
    if (!res.result) throw new Error(res.error?.message ?? 'Stremio would not issue a link code');
    return {
      deviceCode: res.result.code,
      userCode: res.result.code,
      verificationUrl: res.result.link,
      expiresIn: LINK_EXPIRES_IN,
      interval: LINK_POLL_INTERVAL,
    };
  }

  /**
   * Exchange an approved code for a session key. Throws `StremioLinkPending`
   * while the user has not approved it yet, which is the normal case for every
   * poll before the last one.
   */
  static async completeLink(code: string): Promise<string> {
    const http = new HttpClient({ provider: 'stremio', baseUrl: LINK_BASE });
    const res = await http.get<ApiEnvelope<{ authKey: string }>>(
      `/read?type=Read&code=${encodeURIComponent(code)}`,
    );
    if (res.result?.authKey) return res.result.authKey;
    // An unapproved code and an expired one answer identically, so the caller
    // decides when to stop polling rather than trusting the message.
    throw new StremioLinkPending();
  }

  /** Whether the session key still works. */
  async validate(): Promise<boolean> {
    try {
      await this.library();
      return true;
    } catch (err) {
      if (err instanceof StremioSessionInvalid) return false;
      throw err;
    }
  }

  private async library(): Promise<LibraryItem[]> {
    const res = await this.http.post<ApiEnvelope<LibraryItem[]>>('/datastoreGet', {
      authKey: this.authKey,
      collection: LIBRARY_COLLECTION,
      all: true,
      ids: [],
    });
    if (res.error) throw new StremioSessionInvalid();
    return res.result ?? [];
  }

  /**
   * Watched items from the library.
   *
   * A library entry is not a watch: it also holds things saved for later and
   * things merely opened once. `timesWatched` is what Stremio itself uses to
   * decide something has been watched, so that is the test here. Removed items
   * are dropped, and so are the `type: 'other'` entries Stremio keeps for
   * non-video addons.
   */
  async pullHistory(_since?: string | null): Promise<WatchEvent[]> {
    const items = await this.library();

    const watched = items.filter(
      (i) =>
        !i.removed &&
        i.type !== 'other' &&
        (i.state?.timesWatched ?? 0) > 0 &&
        // Stremio meta ids are IMDb ids for anything Cinemeta serves; an addon
        // with its own id space is not something we can map to TMDB.
        /^tt\d+$/.test(i._id),
    );

    const out: WatchEvent[] = [];
    for (const item of watched) {
      const type = item.type === 'movie' ? 'movie' : 'series';
      const ids: ExternalIds = { imdb: item._id };
      const tmdb = await this.resolveImdb?.(item._id, type);
      if (tmdb) ids.tmdb = tmdb;
      out.push({
        ref: {
          kind: type === 'movie' ? 'movie' : 'show',
          ids,
          title: item.name,
        },
        watchedAt: item.state?.lastWatched ?? null,
      });
    }

    log.info(
      { library: items.length, watched: out.length, resolved: out.filter((e) => e.ref.ids.tmdb).length },
      'Stremio library read',
    );
    return out;
  }
}
