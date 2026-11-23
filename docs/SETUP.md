# Set up your own Hydra

Hydra is one person's dashboard. You run your own copy. You bring your own keys. This repo does not contain a database or anyone else's secrets.

You need Node.js 22 or newer and pnpm 10 or newer.

## One command

From this directory:

```
pnpm hydra:setup
```

It asks where this copy will run, then writes `.env` with mode 0600. It creates `HYDRA_TOKEN_KEY`, `CRON_SECRET`, and the web-push (VAPID) keys. It does not print those values. It applies the database migrations and creates the owner login.

Run it again later and it keeps the existing `HYDRA_TOKEN_KEY`. A new token key would make saved bank, Google, and Instagram links unreadable.

### Answers file

Put answers in a file with mode 0600 (`chmod 600 answers.env`). One `KEY=value` per line. Empty means skip.

```
pnpm hydra:setup -- --answers ./answers.env
```

See the plan without writing anything or calling the network:

```
pnpm hydra:setup -- --answers ./answers.env --dry-run
```

```
OPTION=local
ORIGIN=http://localhost:3000
HYDRA_OWNER_EMAIL=you@example.com
```

`OPTION` is `local`, `vps`, or `vercel`.

## 1. Local

Good for trying Hydra on your Mac. No hosting cost.

You need Docker and the [Supabase CLI](https://supabase.com/docs/guides/local-development).

The setup command starts the local stack, applies `supabase/migrations`, reads the local URL and keys, writes `.env`, and creates your user.

Then:

```
pnpm dev
```

Open http://localhost:3000 and sign in with your email. The local mail catcher shows the login message.

The local stack in this repo uses its own ports. Do not point this copy at someone else's Supabase project.

## 2. VPS

Good for an always-on server you control.

You need Docker, a domain, and a Supabase database (Supabase Cloud or your own). The app container does not include the database.

The setup command asks for the Supabase URL and keys, and for a database URL so it can push migrations. The database password is not a command argument and is not written to `.env`.

It also writes `HYDRA_DOMAIN` and `ACME_EMAIL` for Caddy.

On the server:

```
docker compose up -d --build
```

`NEXT_PUBLIC_SUPABASE_URL` is required when the image is built. Compose passes it as a build argument. The secret keys are read from `.env` at run time. They are not baked into the image.

Caddy serves HTTPS for `HYDRA_DOMAIN` and proxies to the app. Point DNS at this machine.

The `cron` service calls these routes with `Authorization: Bearer $CRON_SECRET`:

| Path | When (UTC) |
|---|---|
| `/api/cron/agent` | every minute |
| `/api/cron/planning` | 09:15 |
| `/api/google/cron` | 09:30 |
| `/api/instagram/cron` | 09:45 |
| `/api/cron/bank` | 10:00 |

Check the file with `docker compose config` before you start it.

## 3. Vercel and Supabase Cloud

Good when you do not want to run a server.

You need the Vercel CLI, logged in, and a Supabase project.

The setup command writes `.env` and sets the same variables on the Vercel project for Production and Preview. Values go in on standard input. They are not command arguments and they are not printed.

Deploy with `vercel --prod`, or import the repo in the Vercel dashboard. Crons come from `vercel.json`.

`NEXT_PUBLIC_SUPABASE_URL` must be set before the Vercel build. The setup command sets it.

## Keys

Required:

| Key | Role |
|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | Supabase project URL. The browser can see it. The build needs it. |
| `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` | Supabase publishable key. The browser can see it. Row security guards the data. |
| `SUPABASE_SECRET_KEY` | Server only. Admin client and the owner bootstrap. |
| `HYDRA_OWNER_EMAIL` | The one account that can sign in. |
| `HYDRA_TOKEN_KEY` | Encrypts stored bank, Google, and Instagram tokens. Generated. |
| `CRON_SECRET` | Bearer token for the cron routes. Generated. |

Optional. If a key is missing, that feature stays off:

| Feature | Keys |
|---|---|
| Voice | `FISH_AUDIO_API_KEY`, `FISH_DEFAULT_VOICE_ID` (a Fish Audio voice id, 32 hex characters) |
| Web agent | `ANTHROPIC_API_KEY` |
| Gmail and Calendar | `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` |
| Instagram | `META_APP_ID`, `META_APP_SECRET`, `INSTAGRAM_CONFIG_ID` |
| Bank feed | `PLAID_CLIENT_ID`, `PLAID_SECRET`, `PLAID_ENV` (`sandbox` or `production`) |
| Phone push | `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `VAPID_SUBJECT` |

The setup command does not ask for `INSTAGRAM_APP_ID`, `INSTAGRAM_APP_SECRET`, or `RIPPLE_MEDIA_ORIGIN`. The app does not use them for setup.

Grok uses a key you paste in the app (Settings, Agent, Models). It is stored encrypted. It is not an env var.

## Redirect URLs

Create the Google and Meta apps yourself. Register these redirect URLs, using your site origin:

- `<origin>/api/google/callback`
- `<origin>/api/instagram/callback`

In Supabase Auth, set the Site URL to your origin, add `<origin>/**` to the redirect URLs, and turn public sign-ups off. Set the passkey RP ID to the site host. The RP ID does not change after the first passkey.

## Desktop

The Mac app is a separate program. This setup is the web app only.

## License

AGPL-3.0. See `LICENSE`.
