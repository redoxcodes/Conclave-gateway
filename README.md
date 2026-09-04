# X-verifybot

Telegram gatekeeper for a paid community. Verifies that a member really
owns the X account they claim, checks it against the current subscriber
list, and removes anyone who drops off.

## Flow

```
/start
  → verify with X (OAuth — proves account ownership)
  → back to Telegram
  → on the subscriber list?
      ├─ yes → one-time invite link to the group
      └─ no  → politely rejected

once a day
  → recheck every verified member against the current list
  → remove anyone no longer on it
```

## Commands

| Command | Who | What it does |
|---|---|---|
| `/start` | anyone | Begins verification |
| `/setlist` + one handle per line | admin | Replaces the subscriber list, runs a check |
| `/showlist` | admin | Shows the saved list |
| `/status` | admin | Verified member count + list size |
| `/myid` | anyone | Shows your Telegram user ID |

`/setlist` **replaces** the whole list every time. Always paste the full
current roster, not just new additions.

## Environment variables

| Key | Where it comes from |
|---|---|
| `TELEGRAM_BOT_TOKEN` | @BotFather |
| `TELEGRAM_BOT_USERNAME` | your bot's username, no @ |
| `TELEGRAM_GROUP_ID` | your group's chat id (negative number) |
| `ADMIN_USER_IDS` | your Telegram user id, comma separated for several |
| `X_CLIENT_ID` | developer.x.com → your app |
| `X_CLIENT_SECRET` | developer.x.com → your app |
| `X_CALLBACK_URL` | `<PUBLIC_BASE_URL>/auth/x/callback` |
| `UPSTASH_REDIS_REST_URL` | console.upstash.com |
| `UPSTASH_REDIS_REST_TOKEN` | console.upstash.com |
| `PUBLIC_BASE_URL` | your deployed app's address, no trailing slash |
| `CRON_SECRET` | any long random string you invent |

Never commit these. Set them in the host's environment settings.

## Stack

- Node + Express
- Telegraf (Telegram bot)
- twitter-api-v2 (X OAuth 2.0 with PKCE)
- Upstash Redis (storage)
- Hosted on Render free tier, with cron-job.org driving the daily check
  and keeping the app awake

## Scheduled jobs

The daily check runs via an external cron hitting a protected endpoint,
rather than in-process, so it survives the host sleeping.

- `GET /cron/daily-check?key=<CRON_SECRET>` — once a day
- `GET /ping` — every 10 minutes, keepalive

## Known limitation

X exposes no API for reading who is currently subscribed to you. The
subscriber list has to be supplied manually via `/setlist`. Everything
downstream of that is automatic.
