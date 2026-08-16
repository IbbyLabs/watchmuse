# Privacy

This describes what the hosted Watchmuse instance at **watchmuse.ibbylabs.dev**
does with your data. If you run your own copy, you are the operator and this
does not apply to you — though it is a fair description of what the software
does either way.

Operator and data controller: **IbbyLabs** (<https://ibbylabs.dev>).

## What is collected

**Because you have an account**

- Email address — to sign you in, confirm the address, and reset a password.
- Username, if you set one.
- A hash of your password. The password itself is never stored.
- Sign-in sessions, each with the IP address and browser user-agent that
  created it, so you can be signed out and abuse can be traced.

**Because you connected a service**

- Access and refresh tokens for the accounts you connect (Trakt, Simkl,
  MDBList, PMDB, Letterboxd, Stremio). These are encrypted before storage.
- Your watch history from those services, and any ratings they expose. This is
  the input the recommendations are built from.

**Because you use the addon**

- The catalogs you create and the titles you hide from them.
- The country your requests appear to come from, used to answer "where can I
  watch this". You can pin it yourself instead.

**Optional, only if you choose to**

- An AI provider key and endpoint, encrypted, if you enable AI catalogs.

Nothing is collected for advertising, and there is no analytics or tracking.

## How it is protected

- Passwords are hashed with argon2id.
- Connected-service tokens and AI keys are encrypted at rest with AES-256-GCM.
- Traffic is served over HTTPS. Mail is sent over TLS and the send fails rather
  than falling back to an unencrypted connection.
- The Stremio addon URL contains a random identifier rather than any
  credential, so sharing it does not share your account.

## Who it is shared with

Nobody, other than the services needed to run Watchmuse:

- **TMDB** — for titles, artwork and recommendations. Requests carry title
  identifiers, not who asked.
- **The services you connect** — Trakt, Simkl, MDBList, PMDB, Letterboxd,
  Stremio, on your instruction, using your own account.
- **Your chosen AI provider**, only if you configure one.
- **Brevo**, which relays account emails.

Your data is not sold, and it is not passed to anyone for advertising.

## How long it is kept

For as long as your account exists. Delete your account and the account, its
sessions, connections and cached recommendations go with it. Backups age out on
their own schedule.

## Your rights

If you are in the UK or EU you can ask for a copy of your data, ask for it to
be corrected or deleted, withdraw a consent, or object to how it is handled.
Disconnecting a service removes its tokens immediately.

Ask at <https://dm.ibbylabs.dev> or through
<https://ibbylabs.dev>.

You may also complain to the UK Information Commissioner's Office at
<https://ico.org.uk>.

## Changes

Material changes will be noted here with a new date.

Last updated: 25 July 2026.
