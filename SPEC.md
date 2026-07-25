# Watchmuse — Spec & Plan

> **Codename:** Watchmuse (placeholder, rename freely). Sibling to Watchbridge.
> **One-liner:** A Stremio addon that reads your Trakt/Simkl/PMDB watch history and serves personalized, customisable recommendation catalogs, using a hybrid algorithm + AI engine.
> **Status:** Draft spec, pre-build.

## 1. Concept

Stremio lets addons expose *catalogs* (the horizontal rows on the home/discover screens). Watchmuse is an addon that:

1. Reads what you've watched and rated from Trakt, Simkl, and/or PMDB.
2. Generates recommendation catalogs from that history.
3. Lets you customise catalogs two ways: structured filters and natural-language prompts.
4. Serves those rows back into Stremio, refreshed on a schedule.

It reuses Watchbridge's account model, provider integrations, and encrypted connection store, so users **connect with a button** (OAuth redirect) rather than pasting tokens.

## 2. Decisions locked in

| Question | Decision | Consequence |
|---|---|---|
| Hosting / cost | Public, **BYO-key** for the AI layer | Accounts + dashboard are core. Trakt/Simkl/PMDB connect via the app's own OAuth apps (button, no typing). LLM key is user-supplied and optional. |
| Customisation | **Both** filter-based and natural-language catalogs | Filters are the deterministic backbone; NL is an opt-in layer that needs an LLM key. |
| Reco engine | **Hybrid from day one** | Algorithm does candidate generation; a cheap LLM re-ranks. NL catalogs use the LLM to select/order from the candidate pool. |
| Services | **Trakt, Simkl, PMDB** (all full history sources) + **TMDB** (metadata backbone) | 1..n history providers fan into one normalized watch model, all resolved to TMDB IDs; TMDB powers candidates + display. PMDB is a first-class history source, not just parity. |
| LLM (BYO-key) | **One OpenAI-compatible adapter** covering OpenRouter + local/self-host | User supplies base URL + model + key. Same adapter serves OpenRouter (any model) and Ollama/LM Studio/vLLM. No provider-specific SDKs. |
| Monetisation | **None, everything free** | No billing or entitlement code. The whole addon is free; AI just needs the user's own key. |
| Multi-service history | **Per-catalog source selection** | Each catalog declares which connected services feed it. Cache key and history hash are per source-set, not per user. |
| Poster / metadata | **TMDB directly** in catalog responses | Everything is already resolved to TMDB IDs; pull posters/titles from TMDB for image-quality control rather than round-tripping through Cinemeta. |

### Connect flow (the important bit)

Mirror Watchbridge exactly:

- The **app** holds the Trakt and Simkl OAuth client credentials (`TRAKT_CLIENT_ID/SECRET`, `SIMKL_CLIENT_ID/SECRET`). The user never sees or types these.
- Dashboard shows "Connect Trakt" / "Connect Simkl" buttons. Clicking runs the **authorization-code redirect flow**: user is sent to trakt.tv / simkl.com, approves, gets redirected back with a `code`, the server exchanges it for tokens.
- **Device/PIN flow** as fallback (for clients where redirect is awkward), also already in Watchbridge.
- PMDB connects with whatever mechanism Watchbridge already uses for it.
- Tokens are encrypted at rest with the `secretBox` pattern (`APP_ENCRYPTION_KEY`). Trakt token refresh is persisted back to the store.

The **only** thing a user's Stremio install URL carries is an opaque install ID. No tokens in the manifest URL.

## 3. Architecture

Same stack as Watchbridge: pnpm workspace monorepo, TypeScript, Fastify server, Drizzle ORM over Postgres (PGlite in dev), Docker deploy.

```
packages/
  core/     shared logic: provider adapters, ID mapping, reco engine, catalog eval
  server/   Fastify: accounts, connect/OAuth, dashboard API, Stremio addon endpoints, refresh scheduler
  web/      dashboard: connect buttons, catalog builder (filters + NL), install-URL/QR
```

### Layers

1. **Config / account layer** — reuse Watchbridge auth (register/login/session, encrypted connection store). Add a `catalogs` concept per user.
2. **Normalization layer** — each provider adapter returns a common `WatchedItem`, resolved to a TMDB ID early so everything downstream is provider-agnostic. Reuse Watchbridge's ID-mapping/identity code.
3. **Candidate generation (algorithm)** — from liked/recent items, fan out to Trakt `/recommendations`, Simkl recs, TMDB `/similar` + `/recommendations`. Merge, dedupe vs watched, score.
4. **AI layer (opt-in, BYO-key, cached)** — re-rank the top candidates; NL catalogs select/order from the pool. Runs async, never inline on a catalog request.
5. **Serving layer** — Stremio addon: `manifest`, `catalog`. Delegate `meta`/`stream` to Cinemeta so we don't reimplement metadata delivery.

## 4. Data model (additions on top of Watchbridge's users/connections)

- `catalogs`: `id`, `userId`, `name`, `type` (`filter` | `nl`), `config` (JSON: filters or prompt), `sources` (which connected services feed this catalog, e.g. `['trakt','simkl']`), `mediaType` (movie/series/both), `enabled`, `sortOrder`, timestamps.
- `catalog_cache`: `id`, `catalogId`, `historyHash`, `payload` (JSON list of TMDB IDs + meta), `builtAt`, `expiresAt`. `historyHash` is computed over the catalog's **selected source-set**, so two catalogs drawing from different services cache independently.
- `history_snapshots` (optional): cached normalized `WatchedItem[]` per `(user, source)` with a per-source hash, so a catalog's `historyHash` is just a hash of its chosen sources' snapshot hashes. Avoids re-hitting provider APIs on every refresh.
- LLM config stored encrypted per user (same `secretBox` as provider tokens): `baseUrl`, `model`, `apiKey`. One OpenAI-compatible shape for OpenRouter and local endpoints alike.

## 5. Recommendation engine

### Candidate generation (deterministic, works with zero LLM key)

- Seed set = recent + highly-rated watched items.
- For each seed, gather candidates from: Trakt `/recommendations`, Simkl recommendations, TMDB `/similar` and `/recommendations`.
- Merge into a candidate pool, **dedupe against the user's watched set**.
- Score each candidate by: how many seeds recommended it, source rating/popularity, recency of the matching seed, genre/keyword overlap. Deterministic and cacheable.

### AI layer (opt-in, one OpenAI-compatible adapter)

- Single adapter speaks the OpenAI chat-completions shape. Config is `baseUrl` + `model` + `apiKey`, so it targets OpenRouter (any model) or a local endpoint (Ollama / LM Studio / vLLM) with no code change.
- **Re-rank:** take top ~100 candidates, the user's model reorders for taste coherence. Cache keyed on `(historyHash, catalogId)`.
- **NL catalogs:** prompt + candidate pool → model selects and orders titles that fit the prompt. Cache keyed on `(historyHash, catalogId, promptHash)`.
- No LLM config → NL catalogs are disabled and re-rank falls back to the algorithmic score. Full graceful degradation.
- Since it's the user's own key/endpoint, be defensive: local models vary in quality and may ignore instructions, so validate the model's output (it must return known candidate IDs) and fall back to algorithmic order on malformed responses.

## 6. Catalog system (customisation)

**Filter catalogs** (structured, no AI): genre, year range, runtime, provider/streaming service, min rating, media type, unwatched-only, source list. Example: "Unwatched sci-fi from 2015+ under 2h". Fully deterministic.

**NL catalogs** (LLM): freeform prompt. Example: "movies like the last 5 things I loved but lighter". Needs a user LLM key.

Dashboard catalog builder lets users create, name, order, enable/disable catalogs, and **pick which connected history services feed each catalog** (per-catalog source selection). Default a new catalog to all connected sources; let power users scope a row to just Trakt or just Simkl. Each enabled catalog becomes a row in Stremio via the manifest.

## 7. Caching & refresh (critical for an addon)

Stremio hits catalog endpoints constantly (every home-screen load and scroll). So:

- Catalog responses are **served from `catalog_cache` only**. The request path never calls a provider or an LLM.
- A **background scheduler** (reuse Watchbridge's scheduler) rebuilds caches: on history change (new per-source hash), on catalog edit (including changing its source-set), and on a max-age interval.
- History is normalized and hashed **per source**, so a change in one service only invalidates catalogs that draw from it. Catalogs sharing a source-set share cache work.
- Respect provider rate limits during rebuild; since it's BYO account tokens, quota is per-user, but the app's own OAuth client still has app-level ceilings to watch.

## 8. Security

- Provider tokens and LLM keys encrypted at rest (`secretBox` / `APP_ENCRYPTION_KEY`), same as Watchbridge.
- Manifest URL carries only an opaque install ID; rotating it revokes an install without touching the account.
- OAuth `state` is short-lived, single-use, bound to the user (Watchbridge's `OAuthStateStore`).
- Rate limiting on connect and dashboard endpoints.
- Never log tokens or manifest URLs with secrets.

## 9. Stremio integration specifics

- `manifest.json` per install: lists the user's enabled catalogs as `catalogs[]` with IDs, declares `resources: ['catalog']`, `types: ['movie','series']`.
- `catalog/{type}/{id}.json`: returns the cached list as Stremio meta previews (id, type, name, poster).
- Skip `meta`/`stream`: let Cinemeta/other addons handle those. Watchmuse is recommendations-only.
- Support the `genre`/`skip` (pagination) extras where it makes sense for filter catalogs.

## 10. Milestones

**M0 — Scaffolding**
Fork Watchbridge's monorepo skeleton (core/server/web, auth, connection store, encryption, scheduler). Get accounts + Trakt/Simkl/PMDB button-connect working end to end.

**M1 — Normalized history + candidate generation**
`WatchedItem` model, TMDB ID resolution, aggregation from Trakt/Simkl/TMDB recommendation endpoints, algorithmic scoring. Prove candidate quality with a debug view.

**M2 — Filter catalogs + Stremio serving**
Catalog data model, dashboard builder for filter catalogs, per-user manifest, catalog endpoints, `catalog_cache`, background refresh. This is a shippable v1 with zero AI.

**M3 — AI layer**
BYO LLM key storage, re-rank pass, NL catalogs, prompt-aware caching, graceful degradation without a key.

**M4 — Polish**
Install UX (copyable URL + QR + one-click deep link), catalog reordering, empty/error states, per-catalog refresh controls, docs. Impeccable audit on the dashboard UI. IbbyLabs footer + contact links.

## 11. Resolved decisions (was: open questions)

- **LLM (BYO-key):** one OpenAI-compatible adapter, config = `baseUrl` + `model` + `apiKey`. Covers OpenRouter and local/self-host. No Anthropic/OpenAI-specific SDKs.
- **PMDB:** first-class history source, equal to Trakt/Simkl.
- **Poster/metadata:** TMDB directly in catalog responses (everything's already a TMDB ID).
- **Monetisation:** none, everything free; AI runs on the user's own key.
- **Multi-service history:** per-catalog source selection; cache and history hash are per source-set.

## 12. Remaining nits to settle during build

- Default re-rank behaviour when a user has an LLM key configured but a catalog is small (skip AI under N candidates to save calls?).
- Sensible max number of enabled catalogs per install (Stremio manifest size + refresh cost).
- Whether to expose a "why recommended" explanation (cheap LLM feature) in v1 or defer to post-M4.
