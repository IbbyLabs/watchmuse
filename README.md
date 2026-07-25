# Watchmuse

A [Stremio](https://www.stremio.com) addon that turns your watch history into personalized,
customisable recommendation catalogs. Connect [Trakt](https://trakt.tv),
[Simkl](https://simkl.com), [PublicMetaDB](https://publicmetadb.com) and/or
[MDBList](https://mdblist.com), build catalogs from filters or plain-language prompts, and
Watchmuse serves them back as rows in Stremio.

Recommendations come from a hybrid engine: an algorithm aggregates candidates from Trakt/Simkl/TMDB
and ranks them, and an optional AI layer (bring your own OpenAI-compatible key) re-ranks and powers
natural-language catalogs. Everything works without a key; the AI layer just makes it smarter.

> Status: early. This is the M0 scaffold — accounts and button-based provider connections work.
> The recommendation engine, catalog builder, and Stremio addon endpoints land in later milestones.
> See [`SPEC.md`](SPEC.md) for the full plan.

## Run it

Docker (Postgres + local mail capture):

```bash
cp .env.sample .env         # then fill APP_ENCRYPTION_KEY and SESSION_SECRET
docker compose up --build
```

- App: http://localhost:8080
- Captured emails (dev): http://localhost:8025

Generate the two required secrets:

```bash
openssl rand -base64 32     # APP_ENCRYPTION_KEY
openssl rand -base64 48     # SESSION_SECRET
```

## Develop

Node ≥22 and pnpm ≥11.

```bash
pnpm install
pnpm dev        # server (8080) + web (5173) in watch mode
pnpm test       # unit + integration
pnpm build      # build all packages
```

By default the server uses embedded PGlite under `./data` — no external database needed. Set
`DATABASE_URL=postgres://…` to use a real Postgres.

## Connecting accounts

Trakt and Simkl connect with a button (OAuth redirect, with a device/PIN fallback). The operator
registers OAuth apps once and sets `TRAKT_*` / `SIMKL_*`; users never type tokens. Tokens are
encrypted at rest (AES-256-GCM) and refreshed automatically.

## Configuration

All configuration is via environment variables — see [`.env.sample`](.env.sample) for the full
list. Notable ones:

| Variable               | Purpose                                                                             |
| ---------------------- | ----------------------------------------------------------------------------------- |
| `APP_ENCRYPTION_KEY`   | 32-byte key that encrypts stored provider tokens and LLM keys (AES-256-GCM)         |
| `SESSION_SECRET`       | Session/cookie secret                                                               |
| `DATABASE_URL`         | `pglite://…` (embedded) or `postgres://…`                                           |
| `TRUSTED_PROXIES`      | `cloudflare`, `loopback`, `private`, or explicit CIDRs — controls real-IP detection |
| `REGISTRATION_ENABLED` | Toggle public sign-ups                                                              |
| `SMTP_*` / `MAIL_FROM` | Outgoing mail for email verification                                                |
| `TRAKT_*` / `SIMKL_*`  | Operator-registered OAuth app credentials                                           |

Behind Cloudflare, set `TRUSTED_PROXIES=cloudflare` so per-IP rate limits use the real visitor IP
from `CF-Connecting-IP`, not the Cloudflare edge.

## Layout

- `packages/core` — config, crypto, real-IP resolution, provider adapters (Trakt/Simkl/PMDB/MDBList),
  ID-based matching (`matching/identity.ts`, reused for TMDB resolution), and (later) the
  recommendation engine
- `packages/server` — Fastify API, auth, email, encrypted connection store, and (later) the catalog
  refresh scheduler and Stremio addon endpoints
- `packages/web` — React SPA (dashboard) served by the server in production

This started as a fork of the Watchbridge skeleton for the shared plumbing (accounts, provider
OAuth, encryption, stack). Watchbridge's sync engine and scheduler were removed — Watchmuse doesn't
sync anything. M2 adds its own catalog-cache scheduler.

## Images

Published to `ghcr.io/ibbylabs/watchmuse` as native `linux/amd64` and `linux/arm64` (no
emulation).

## Privacy

The hosted instance's privacy notice is in [PRIVACY.md](PRIVACY.md). Running your own copy makes
you the operator, and it does not apply to you.

## License

[AGPL-3.0](LICENSE). Run it, modify it, self-host it. If you run a modified version as a network
service, publish your changes.
