import {
  LetterboxdClient,
  StremioClient,
  StremioLinkPending,
  TmdbClient,
  MdblistClient,
  PmdbClient,
  SimklClient,
  TraktClient,
  type AppConfig,
  type DeviceCode,
  type ProviderId,
} from '@watchmuse/core';

/** A connected, authenticated provider client. */
export type ProviderClient =
  | StremioClient
  | TraktClient
  | SimklClient
  | PmdbClient
  | MdblistClient
  | LetterboxdClient;
import type { ConnectionStore, PublicConnection } from './store.js';
import type { OAuthStateStore, RedirectProvider } from './oauthState.js';

export class ProviderNotConfigured extends Error {
  constructor(readonly provider: ProviderId) {
    super(`${provider} is not configured on this server`);
    this.name = 'ProviderNotConfigured';
  }
}

export class OAuthStateError extends Error {
  constructor() {
    super('The sign-in link is invalid or expired');
    this.name = 'OAuthStateError';
  }
}

export type PollStatus = 'pending' | 'connected' | 'expired' | 'denied' | 'slow_down';

/**
 * Builds provider clients from server config + stored per-user credentials, and
 * drives the connect flows. Trakt clients persist refreshed tokens back to the store.
 */
export class ConnectionService {
  constructor(
    private readonly store: ConnectionStore,
    private readonly config: AppConfig,
    private readonly states: OAuthStateStore,
  ) {}

  isConfigured(provider: ProviderId): boolean {
    if (provider === 'trakt')
      return Boolean(this.config.TRAKT_CLIENT_ID && this.config.TRAKT_CLIENT_SECRET);
    if (provider === 'simkl') return Boolean(this.config.SIMKL_CLIENT_ID);
    return true; // pmdb and mdblist are per-user keys, always available
  }

  /** Whether the redirect (authorization-code) flow is available — needs a secret. */
  redirectConfigured(provider: RedirectProvider): boolean {
    if (provider === 'trakt') return this.isConfigured('trakt');
    return Boolean(this.config.SIMKL_CLIENT_ID && this.config.SIMKL_CLIENT_SECRET);
  }

  // ── Authorization-code (redirect) flow ───────────────────────────

  private redirectUri(provider: RedirectProvider): string {
    return `${this.config.APP_URL}/api/connections/${provider}/callback`;
  }

  /** Build the provider authorize URL to send the user's browser to. */
  async authorizeUrl(userId: string, provider: RedirectProvider): Promise<string> {
    if (!this.redirectConfigured(provider)) throw new ProviderNotConfigured(provider);
    const state = await this.states.create(userId, provider);
    const uri = this.redirectUri(provider);
    return provider === 'trakt'
      ? this.newTrakt().authorizeUrl(uri, state)
      : this.newSimkl().authorizeUrl(uri, state);
  }

  /** Handle the callback: validate state, exchange the code, store the connection. */
  async completeRedirect(
    state: string,
    code: string,
    currentUserId: string,
  ): Promise<RedirectProvider> {
    const entry = await this.states.consume(state);
    if (!entry || entry.userId !== currentUserId) throw new OAuthStateError();
    const uri = this.redirectUri(entry.provider);

    if (entry.provider === 'trakt') {
      const tokens = await this.newTrakt().exchangeCode(code, uri);
      let label = 'Trakt';
      try {
        const settings = await this.newTrakt(tokens).getSettings();
        if (settings.username) label = settings.username;
      } catch {
        // keep default label
      }
      await this.store.upsert(currentUserId, 'trakt', label, { kind: 'trakt', ...tokens });
    } else {
      const accessToken = await this.newSimkl().exchangeCode(code, uri);
      await this.store.upsert(currentUserId, 'simkl', 'Simkl', { kind: 'simkl', accessToken });
    }
    return entry.provider;
  }

  // ── Trakt device flow ────────────────────────────────────────────

  startTraktDevice(): Promise<DeviceCode> {
    return this.newTrakt().requestDeviceCode();
  }

  async pollTraktDevice(userId: string, deviceCode: string): Promise<PollStatus> {
    const client = this.newTrakt();
    const res = await client.pollDeviceToken(deviceCode);
    if (typeof res === 'string') return res;

    let label = 'Trakt';
    try {
      const settings = await this.newTrakt(res).getSettings();
      if (settings.username) label = settings.username;
    } catch {
      // Non-fatal: keep the default label.
    }
    await this.store.upsert(userId, 'trakt', label, {
      kind: 'trakt',
      accessToken: res.accessToken,
      refreshToken: res.refreshToken,
      expiresAt: res.expiresAt,
    });
    return 'connected';
  }

  // ── Simkl PIN flow ───────────────────────────────────────────────

  startSimklPin() {
    return this.newSimkl().requestPin();
  }

  async pollSimklPin(userId: string, userCode: string): Promise<PollStatus> {
    const res = await this.newSimkl().pollPin(userCode);
    if (res === 'pending') return 'pending';
    await this.store.upsert(userId, 'simkl', 'Simkl', { kind: 'simkl', accessToken: res });
    return 'connected';
  }

  // ── PMDB api key ─────────────────────────────────────────────────

  async connectPmdb(userId: string, apiKey: string): Promise<PublicConnection> {
    const ok = await new PmdbClient(apiKey).validate();
    if (!ok) throw new InvalidApiKey();
    return this.store.upsert(userId, 'pmdb', 'PublicMetaDB', { kind: 'pmdb', apiKey });
  }

  // ── MDBList api key ───────────────────────────────────────────────

  async connectMdblist(userId: string, apiKey: string): Promise<PublicConnection> {
    const ok = await new MdblistClient(apiKey).validate();
    if (!ok) throw new InvalidApiKey();
    return this.store.upsert(userId, 'mdblist', 'MDBList', { kind: 'mdblist', apiKey });
  }

  // ── Stremio link flow ─────────────────────────────────────────────

  startStremioLink(): Promise<DeviceCode> {
    return StremioClient.startLink();
  }

  async pollStremioLink(userId: string, code: string): Promise<PollStatus> {
    let authKey: string;
    try {
      authKey = await StremioClient.completeLink(code);
    } catch (err) {
      // Stremio answers an unapproved code and an expired one the same way, so
      // this stays 'pending' and the client's own deadline ends the wait.
      if (err instanceof StremioLinkPending) return 'pending';
      throw err;
    }
    await this.store.upsert(userId, 'stremio', 'Stremio', { kind: 'stremio', authKey });
    return 'connected';
  }

  // ── Letterboxd username ───────────────────────────────────────────

  async connectLetterboxd(userId: string, username: string): Promise<PublicConnection> {
    // Constructing the client validates the username shape and throws if it is
    // not one Letterboxd could have issued.
    const ok = await new LetterboxdClient(username).validate();
    if (!ok) throw new LetterboxdProfileUnavailable();
    return this.store.upsert(userId, 'letterboxd', `Letterboxd (${username})`, {
      kind: 'letterboxd',
      username,
    });
  }

  // ── Connected clients (for the sync engine) ──────────────────────

  async traktFor(userId: string): Promise<TraktClient | null> {
    const c = await this.store.getCreds(userId, 'trakt');
    if (!c || c.creds.kind !== 'trakt') return null;
    const connId = c.id;
    return this.newTrakt(
      {
        accessToken: c.creds.accessToken,
        refreshToken: c.creds.refreshToken,
        expiresAt: c.creds.expiresAt,
      },
      (tokens) => this.store.updateCreds(connId, { kind: 'trakt', ...tokens }),
    );
  }

  async simklFor(userId: string): Promise<SimklClient | null> {
    const c = await this.store.getCreds(userId, 'simkl');
    if (!c || c.creds.kind !== 'simkl') return null;
    return this.newSimkl(c.creds.accessToken);
  }

  async pmdbFor(userId: string): Promise<PmdbClient | null> {
    const c = await this.store.getCreds(userId, 'pmdb');
    if (!c || c.creds.kind !== 'pmdb') return null;
    return new PmdbClient(c.creds.apiKey);
  }

  async stremioFor(userId: string): Promise<StremioClient | null> {
    const c = await this.store.getCreds(userId, 'stremio');
    if (!c || c.creds.kind !== 'stremio') return null;
    // Stremio's library is keyed by IMDb id, so the client needs a way into
    // TMDB space. Without a TMDB key the items still come back, just unmapped,
    // and the reco pipeline skips them.
    const key = this.config.TMDB_API_KEY;
    const tmdb = key ? TmdbClient.shared({ apiKey: key }) : null;
    return new StremioClient(
      c.creds.authKey,
      tmdb ? (imdbId, type) => tmdb.findByImdbId(imdbId, type) : undefined,
    );
  }

  async letterboxdFor(userId: string): Promise<LetterboxdClient | null> {
    const c = await this.store.getCreds(userId, 'letterboxd');
    if (!c || c.creds.kind !== 'letterboxd') return null;
    return new LetterboxdClient(c.creds.username);
  }

  async mdblistFor(userId: string): Promise<MdblistClient | null> {
    const c = await this.store.getCreds(userId, 'mdblist');
    if (!c || c.creds.kind !== 'mdblist') return null;
    return new MdblistClient(c.creds.apiKey);
  }

  /** A connected, authenticated client for a provider. */
  async clientFor(userId: string, provider: ProviderId): Promise<ProviderClient | null> {
    if (provider === 'trakt') return this.traktFor(userId);
    if (provider === 'simkl') return this.simklFor(userId);
    if (provider === 'mdblist') return this.mdblistFor(userId);
    if (provider === 'letterboxd') return this.letterboxdFor(userId);
    if (provider === 'stremio') return this.stremioFor(userId);
    return this.pmdbFor(userId);
  }

  // ── factories ────────────────────────────────────────────────────

  private newTrakt(
    tokens?: { accessToken: string; refreshToken: string; expiresAt: number },
    onRefresh?: (t: {
      accessToken: string;
      refreshToken: string;
      expiresAt: number;
    }) => Promise<void>,
  ): TraktClient {
    if (!this.isConfigured('trakt')) throw new ProviderNotConfigured('trakt');
    return new TraktClient({
      clientId: this.config.TRAKT_CLIENT_ID!,
      clientSecret: this.config.TRAKT_CLIENT_SECRET!,
      tokens,
      onRefresh,
    });
  }

  private newSimkl(accessToken?: string): SimklClient {
    if (!this.isConfigured('simkl')) throw new ProviderNotConfigured('simkl');
    return new SimklClient({
      clientId: this.config.SIMKL_CLIENT_ID!,
      clientSecret: this.config.SIMKL_CLIENT_SECRET,
      accessToken,
      // Sourced from config so a release/v tag bumps it (see APP_VERSION wiring).
      appName: this.config.APP_NAME,
      appVersion: this.config.APP_VERSION,
    });
  }
}

export class InvalidApiKey extends Error {
  constructor() {
    super('The API key was rejected');
    this.name = 'InvalidApiKey';
  }
}

export class LetterboxdProfileUnavailable extends Error {
  constructor() {
    super('That Letterboxd profile could not be read. Check the username, and that the diary is public');
    this.name = 'LetterboxdProfileUnavailable';
  }
}
