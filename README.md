# Hydra

A private, single-owner life and business dashboard with a voice agent: money (accounts, transactions, reports, taxes),
UGC deals and payouts, Personal Brand, Planning (board, calendar, goals), Notes, and the Hydra Agent.
The Mac app is a separate program. This repository is the web app only.

Each person runs their **own copy** with **their own keys**. Nothing in this repo holds anyone's data or secrets.

## Pick a setup

Run `pnpm hydra:setup` to write your `.env` (mode 0600), apply migrations, and create the owner login.
The full steps are in [docs/SETUP.md](docs/SETUP.md).

| Option | Where it runs | Good for |
|---|---|---|
| 1. Local | Your Mac: Supabase CLI local stack + `pnpm start` | Trying it, full privacy, no hosting cost |
| 2. VPS | Your server: Next.js (Node 22+) behind Caddy or nginx with HTTPS, Supabase cloud or self-hosted | Always on, your own box |
| 3. Vercel + Supabase cloud | Vercel project + Supabase project | Easiest always-on setup |

### Common steps

1. `git clone` this repo, then `pnpm install` (Node 22+, pnpm 10+).
2. `pnpm hydra:setup`, or copy `.env.example` to `.env` and fill in the keys (see below). Never commit `.env`.
3. Database: apply the migrations in `supabase/migrations`.
   - Local: `supabase start`, then `supabase migration up --local` (the setup command does this).
   - Cloud: create a Supabase project, then push the migrations. The setup command can do this from a database URL.
4. Create your owner login: set `HYDRA_OWNER_EMAIL`, then `node --experimental-strip-types scripts/bootstrap-owner.mts`. The setup command does this.
5. Run it:
   - Local or VPS: `pnpm build && pnpm start` (VPS: `docker compose up -d --build`, and set your domain in Supabase Auth redirect URLs).
   - Vercel: import the repo, add the same env vars in Project Settings, deploy. Crons are in `vercel.json`
     (on a VPS, the compose cron service calls those routes with `Authorization: Bearer $CRON_SECRET`).

## Your keys

Required: `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`, `SUPABASE_SECRET_KEY`, `HYDRA_OWNER_EMAIL`,
`HYDRA_TOKEN_KEY` (`openssl rand -base64 32`), `CRON_SECRET` (`openssl rand -hex 32`).

`pnpm hydra:setup` creates `HYDRA_TOKEN_KEY`, `CRON_SECRET`, and the VAPID keys. It does not print them.

Optional, one feature each (missing = that feature is off):

| Feature | Keys | Where to get them |
|---|---|---|
| Voice | `FISH_AUDIO_API_KEY`, `FISH_DEFAULT_VOICE_ID` | fish.audio developer page; any voice's id |
| Agent on the web | `ANTHROPIC_API_KEY` | platform.claude.com |
| Gmail and Calendar | `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | Google Cloud OAuth client (Web), redirect `<your origin>/api/google/callback` |
| Instagram (Personal Brand) | `META_APP_ID`, `META_APP_SECRET`, `INSTAGRAM_CONFIG_ID` | Meta app with Facebook Login for Business (Instagram), redirect `<your origin>/api/instagram/callback` |
| Bank feed | `PLAID_CLIENT_ID`, `PLAID_SECRET`, `PLAID_ENV` | dashboard.plaid.com |
| Phone push | `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `VAPID_SUBJECT` | `npx web-push generate-vapid-keys` |
| Grok | pasted in the app (Settings > Agent > Models) | console.x.ai |

Each OAuth app (Google, Meta) must be your own, with your own redirect URL.

## Checks

`pnpm typecheck`, `pnpm lint`, `pnpm test`. `pnpm verify` runs the full gate (needs the local Supabase stack).

## License

AGPL-3.0. See `LICENSE`.
