# Ticket Tracker

A separate mobile page for a one-day event. Signed-in admins scan QR codes and mark them seen. The records live in a private GitHub repository as JSON. There is no database server to install.

Without a login, the page only says: “For you, without login, we will not allow you.”

**Seen** means a scan was saved. It does not prove that someone photographed the QR or received a product.

This site is not part of the existing display or photo pages.

## Share link

Static page (gate only until the API is connected):

https://rahiakil.github.io/ticket-tracker/

GitHub Pages cannot run the login or save scans. The private API is a Cloudflare Worker in this repository (`src/worker.mjs`). It is **not deployed yet**. Until that worker is connected, the shared page cannot sign anyone in. That is not demo mode.

**Demo mode** is only the local server. It shows a banner: “Demo mode. These records are local and are not the live event file.”

## Repository split

| | |
| --- | --- |
| This public repo | the page, API, and tests |
| `rahiakil/ticket-tracker-data` (private) | `event-state.json` and `users.json` |

The browser never receives `users.json`, password hashes, the GitHub token, or the session secret.

## QR codes

Only this link shape is accepted. The scanner does not open other URLs.

`https://rahiakil.github.io/ticket-tracker/?c=<id>`

The id is a random 128-bit token from the admin “Generate QR codes” action. Opening the link, or any GET request, does not mark it seen. A signed-in admin must tap **Confirm seen**. The camera starts only after **Scan QR**. Decoding happens on the phone; camera frames and uploaded images are not sent to the server. “Recorded” appears only after the private file is saved.

If the code was already saved, the result is “Already seen” and no second scan event is added. Other results are “Invalid code”, “Could not save—retry”, and “Event closed”.

## Private JSON

`event-state.json` holds schema version 1, the event open/closed flag, issued ids, the current seen state, server timestamps, an append-only history, and processed request ids. A scan and its history line are written in the same commit. Saving uses the GitHub Contents API and the file SHA. A conflict refetches, reapplies that one change, and retries up to five times.

`users.json` holds usernames, roles, and scrypt password hashes (`@noble/hashes`). Passwords are checked only on the server.

Examples that are safe to read: `samples/event-state.sample.json`, `samples/users.sample.json`, and the sanitized export `samples/report.sample.json`. The sample user hash is not a real account.

## Local demo

From this folder, with Node 20 or newer:

```powershell
Set-Content -Path password.txt -Value "choose-a-long-password" -NoNewline
Get-Content -Raw password.txt | node scripts/init-demo.mjs "Ada Admin"
Remove-Item password.txt
npm start
```

Open http://127.0.0.1:8787 . The first login must change that password before scans work. `data-local/` is gitignored.

To hash a password without writing a user file:

```powershell
Get-Content -Raw password.txt | npm run hash-password
```

## Live admin accounts

Add or replace an admin, then commit `users.json` only in the private data repository:

```powershell
Get-Content -Raw password.txt | node scripts/upsert-user.mjs --file users.json --username "Second Admin" --role admin --must-change
Remove-Item password.txt
```

Do not commit `password.txt` or a plaintext password. There is no registration or password-reset email. The signed-in admin can also change their password on the page.

The first account is already in the private `users.json`. Sign in and change the password before generating codes or sharing a working link. Scans stay blocked until that change.

## Backend secrets

Create a fine-grained GitHub personal access token:

- Resource owner: `rahiakil`
- Repository access: only `ticket-tracker-data`
- Permissions: Contents, read and write
- No other permissions

Deploy the Worker when you are ready. No paid Cloudflare plan is required for a one-day event, and this setup did not deploy it.

```powershell
npx wrangler login
npx wrangler secret put SESSION_SECRET
npx wrangler secret put GITHUB_TOKEN
npx wrangler deploy
```

`SESSION_SECRET` must be at least 32 random characters. `wrangler.toml` already points at the private repository. It sets `COOKIE_SAMESITE` to `None` so the GitHub Pages origin can call the worker. After `npx wrangler deploy` prints an `https://….workers.dev` URL:

1. Put that origin in `web/config.js` as `apiBase` (no trailing slash).
2. Commit and push so GitHub Pages publishes it.
3. Log in immediately and change the setup password.

Cookies are `Secure`, `HttpOnly`, and host-only. They expire after 8 hours. State-changing requests need the CSRF token from login. Login attempts are limited per address.

### Same-origin hosting

Prefer one HTTPS origin for the page and the API. The Worker can serve `web/` and `/api` together. For that, set `COOKIE_SAMESITE` to `Lax`, set `PUBLIC_PAGE_URL` to the worker (or custom domain) URL with a trailing slash, and leave `apiBase` empty. Generate QR codes only after `PUBLIC_PAGE_URL` is the link you will actually share.

Use that Cloudflare URL, not GitHub Pages, if the event is commercial. GitHub Pages is a static host, and GitHub does not allow Pages for a commercial website. A separate worker is required whenever the page stays on `github.io`, because Pages cannot store the token or set this session cookie by itself.

## What was tested

`npm test` (25 passing tests in this workspace) covers the first scan, a repeat scan, two simultaneous scans, SHA conflicts, bounded retries, invalid codes, a foreign URL that contains a real id, event closure, login and logout, a forged session, a non-admin reversal, a missing CSRF token, and scan → undo → scan.

These tests do not open a phone camera. Rear-camera permission, the iPhone Safari and Android Chrome viewfinder, and photo upload still need a physical phone on the HTTPS site after the worker is deployed. If the camera is denied, the page keeps an “Upload QR image” button and decodes that file locally.

No paid service was provisioned, and the worker deploy was not run.
