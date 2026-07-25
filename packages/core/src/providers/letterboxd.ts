import { XMLParser } from 'fast-xml-parser';
import { createLogger } from '../logger.js';
import { HttpClient, HttpError } from './http.js';
import type { ProviderCapabilities, WatchEvent } from './types.js';

const log = createLogger('letterboxd');

const LETTERBOXD_BASE = 'https://letterboxd.com';

/**
 * Letterboxd usernames are alphanumeric with underscores. The value comes from
 * the user and is interpolated into a URL path, so it is checked against this
 * rather than escaped: anything outside the set is a typo or an attempt to
 * reach a different path, and neither is worth requesting.
 */
const USERNAME = /^[a-zA-Z0-9_]{1,30}$/;

/** Letterboxd rates out of 5 in half-steps; the rest of Watchmuse works in 1-10. */
const RATING_SCALE = 2;

export class InvalidLetterboxdUsername extends Error {
  constructor() {
    super('Letterboxd usernames may only contain letters, numbers and underscores');
    this.name = 'InvalidLetterboxdUsername';
  }
}

interface RssItem {
  'letterboxd:watchedDate'?: string;
  'letterboxd:filmTitle'?: string;
  'letterboxd:filmYear'?: number;
  'letterboxd:memberRating'?: number;
  'tmdb:movieId'?: number;
}

/**
 * Letterboxd as a read-only history source, via the public diary RSS feed.
 *
 * No API key and no OAuth: the feed at /{user}/rss/ is public for a public
 * profile. Every diary entry carries `tmdb:movieId`, so entries need no title
 * matching, and most carry a star rating, which is a stronger taste signal than
 * the bare "watched" most sources give.
 *
 * Two limits are inherent to the feed and not worth pretending away. It holds
 * roughly the last 50 diary entries, so this is recent taste rather than a full
 * library; and Letterboxd is films only, so it contributes no series at all.
 */
export class LetterboxdClient {
  readonly id = 'letterboxd' as const;
  private readonly http: HttpClient;
  private readonly parser = new XMLParser({
    ignoreAttributes: true,
    // Titles and years must not be coerced inconsistently; numeric fields are
    // read through Number() below so a "2025" title cannot become a number.
    parseTagValue: false,
  });

  constructor(readonly username: string) {
    if (!USERNAME.test(username)) throw new InvalidLetterboxdUsername();
    this.http = new HttpClient({
      provider: 'letterboxd',
      baseUrl: LETTERBOXD_BASE,
      minIntervalMs: 1000, // a courtesy pace: this is a public page, not an API
      headers: { 'user-agent': 'Watchmuse', accept: 'application/rss+xml, application/xml' },
      // The feed lives at a fixed path; a redirect would mean the profile moved
      // or the name is wrong, neither of which we want to follow blindly.
      followRedirects: false,
    });
  }

  capabilities(): ProviderCapabilities {
    return { history: true, progress: false, ratings: true, watchlist: false, datedHistory: true };
  }

  /** Whether the profile exists and its diary is public. */
  async validate(): Promise<boolean> {
    try {
      await this.fetchFeed();
      return true;
    } catch (err) {
      // A private or missing profile answers 404; both mean "cannot use this".
      if (err instanceof HttpError && (err.status === 404 || err.status === 403)) return false;
      throw err;
    }
  }

  private async fetchFeed(): Promise<string> {
    return this.http.getText(`/${this.username}/rss/`);
  }

  /**
   * Diary entries from the feed, newest first.
   *
   * The feed mixes diary entries with the member's published lists, and a list
   * item has no watched date and no film id. Presence of a watched date is what
   * separates them; without that check half the feed arrives as junk.
   */
  async pullHistory(_since?: string | null): Promise<WatchEvent[]> {
    let xml: string;
    try {
      xml = await this.fetchFeed();
    } catch (err) {
      // An unreachable feed is not an empty diary. Swallowing it would report a
      // user as having watched nothing and reshape every recommendation built
      // from that. Let it throw; the caller skips this provider for the run.
      log.warn({ username: this.username, err }, 'Failed to read the Letterboxd diary');
      throw err;
    }

    const parsed = this.parser.parse(xml) as {
      rss?: { channel?: { item?: RssItem | RssItem[] } };
    };
    const raw = parsed.rss?.channel?.item;
    if (!raw) return [];
    // A feed with exactly one entry parses to an object rather than an array.
    const items = Array.isArray(raw) ? raw : [raw];

    const out: WatchEvent[] = [];
    for (const item of items) {
      const watchedAt = item['letterboxd:watchedDate'];
      const tmdb = Number(item['tmdb:movieId']);
      if (!watchedAt || !Number.isFinite(tmdb) || tmdb <= 0) continue;

      const stars = Number(item['letterboxd:memberRating']);
      out.push({
        ref: {
          kind: 'movie',
          ids: { tmdb },
          title: item['letterboxd:filmTitle']?.toString(),
          year: Number(item['letterboxd:filmYear']) || undefined,
        },
        watchedAt,
        ...(Number.isFinite(stars) && stars > 0 ? { rating: stars * RATING_SCALE } : {}),
      });
    }

    log.info({ username: this.username, entries: out.length }, 'Letterboxd diary read');
    return out;
  }
}
