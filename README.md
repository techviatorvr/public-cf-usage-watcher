## This tool may no longer be needed 
Cloudflare is launching Billing Budget Alerts: 
https://developers.cloudflare.com/billing/manage/budget-alerts/

# Cloudflare Usage Watcher

Cloudflare Worker that checks account-wide usage every 10 minutes, alerts at 50%, 75%, and 90%, features a 15% velocity breaker to catch rapid spikes, uses KV for the breaker flag, and stores run history in D1 for the root dashboard.

## What it watches

- Workers daily requests: `100,000`
- D1 monthly rows read: `5,000,000`
- D1 monthly rows written: `100,000`
- R2 monthly Class A operations: `1,000,000`
- R2 monthly Class B operations: `10,000,000`

## Files

- [`src/index.js`](./src/index.js) - scheduled watcher, GraphQL queries, alerts, breaker state, and D1 run history.
- Root URL - renders the latest usage run from D1, including usage percentages, breaker state, recent history, and failures.
- [`schema.sql`](./schema.sql) - D1 schema for the usage history table.
- [`src/usage-breaker.js`](./src/usage-breaker.js) - reusable middleware-style breaker check for your other Workers.
- [`wrangler.toml`](./wrangler.toml) - Cron trigger and KV binding.

## Circuit breaker snippet

If you want the smallest possible copy/paste version, use this directly in another Worker:

```js
async function enforceUsageBreaker(env) {
  const limitExceeded = await env.USAGE_STATE.get("LIMIT_EXCEEDED");
  if (limitExceeded === "true") return new Response("Daily Limit Reached", { status: 503 });
  return null;
}

export default {
  async fetch(request, env, ctx) {
    const breaker = await enforceUsageBreaker(env);
    if (breaker) return breaker;
    return new Response("OK");
  },
};
```

If you prefer a reusable helper file, use [`src/usage-breaker.js`](./src/usage-breaker.js). If you want the same logic in a standalone pasteable module, use [`src/usage-breaker-inline.js`](./src/usage-breaker-inline.js).

## Dashboard setup

1. Create a KV namespace named `USAGE_STATE`.
2. Bind that same namespace in this watcher and every Worker you want protected.
3. Create a D1 database for the watcher history and bind it as `DB`.
4. Create a Cloudflare API token with `Account > Analytics > Read`.
5. Choose an email provider (`resend`, `mailchannels`, `postmark`, `zeptomail`) and set `EMAIL_PROVIDER`.
6. Get your chosen provider's API key and set it as the secret `EMAIL_API_KEY` (except for MailChannels, which doesn't need one).
7. If using Push alerts, choose a provider (`telegram` or `ntfy`) and set `PUSH_PROVIDER`, then set `TELEGRAM_BOT_TOKEN` or `NTFY_AUTH_TOKEN` as a secret.
8. Set `ALERT_TO_EMAIL`, `EMAIL_FROM_ADDRESS`, `TELEGRAM_CHAT_ID`, and `NTFY_TOPIC_URL` (as needed).
9. If Cloudflare Access protects the public watcher URL, set `CF_ACCESS_AUDIENCE` and `CF_ACCESS_JWK_URL` as vars.
10. Toggle `NOTIFY_VIA_EMAIL` and `NOTIFY_VIA_PUSH` inside `wrangler.toml` depending on your preferred alert channels.
11. Deploy the worker and confirm the cron trigger is enabled.

## Quick Wrangler deploy checklist

1. Run `wrangler login` once on your machine if you have not already.
2. Create the `USAGE_STATE` KV namespace and copy the namespace ID into [`wrangler.toml`](./wrangler.toml).
3. Create or bind the D1 database and copy the database ID into [`wrangler.toml`](./wrangler.toml).
4. Add the required secrets and vars:
   - `wrangler secret put CF_API_TOKEN`
   - `wrangler secret put CF_ACCOUNT_ID`
   - `wrangler secret put EMAIL_API_KEY` (if using Resend, Postmark, or ZeptoMail)
   - `wrangler secret put TELEGRAM_BOT_TOKEN` (if using Telegram)
   - `wrangler secret put NTFY_AUTH_TOKEN` (if using Ntfy with authentication)
   - Set `EMAIL_PROVIDER`, `ALERT_TO_EMAIL`, `EMAIL_FROM_ADDRESS`, `PUSH_PROVIDER`, `TELEGRAM_CHAT_ID`, `NOTIFY_VIA_EMAIL`, and `NOTIFY_VIA_PUSH` in `wrangler.toml` or via dashboard vars.
5. Deploy with `wrangler deploy`.
6. Confirm the scheduled trigger appears in the Cloudflare dashboard and that the Worker logs show a successful cron run.

## Applying the schema

If you created a brand-new D1 database, apply the schema once before the first deploy:

```bash
npx wrangler d1 execute usage-watcher --remote --file ./schema.sql
```

If you are testing locally, swap `--remote` for `--local`.

## How the reset logic works

- Workers reset daily at `00:00 UTC`.
- D1 and R2 reset on the 1st of the month.
- **Velocity Tracker:** If a monitored metric spikes by exactly or more than 15% of its entire absolute limit within a single 10-minute snapshot interval, it gets treated as an active breach (Surge), regardless of whether it hit the 50% absolute threshold yet. This protects free tiers from sudden attacks instantly throwing the circuit breaker.
- When a metric returns to zero, the watcher clears that metric’s alert-cooling state and removes it from the active breach list.
- `LIMIT_EXCEEDED` stays `true` while any metric remains in breach state and flips back to `false` once all active breach flags are cleared.
- The root page keeps the latest 10 cron snapshots in D1, and runs older than 90 days are pruned automatically.

## Cloudflare Access

If you enable Cloudflare Access on the watcher URL, the worker validates the `Cf-Access-Jwt-Assertion` header before rendering the dashboard.

- `CF_ACCESS_AUDIENCE` should match the Access application audience.
- `CF_ACCESS_JWK_URL` should point at the Access JWKs endpoint.
- `TIME_ZONE` controls the local timezone shown next to the UTC "Last checked" timestamp. Default: `America/Chicago`.
- `/health` remains available for simple health checks.
- `/debug/access` returns a safe JSON diagnosis of why Access validation passed or failed.
- `/debug/test-alert` sends a manual alert email through the configured provider as a real threshold breach.
- The dashboard also exposes `window.sendUsageWatcherTestAlert()` in the browser console.

## Configuration Variables

The following variables and secrets must be configured before deployment. Update these inside `wrangler.toml` or via the Cloudflare Dashboard (`Settings > Variables and Secrets`).

**Infrastructure Bindings (in `wrangler.toml`)**
- `kv_namespaces.id`: Replace `#REPLACE WITH YOURS` with your KV Namespace ID.
- `d1_databases.database_id`: Replace `#REPLACE WITH YOURS` with your D1 Database ID.

**Secrets (add via `wrangler secret put <NAME>`)**
- `CF_API_TOKEN`: Cloudflare API token with `Account > Analytics > Read` permissions.
- `CF_ACCOUNT_ID`: Your Cloudflare Account ID.
- `EMAIL_API_KEY`: API Key for your chosen email provider (not needed for MailChannels).
- `TELEGRAM_BOT_TOKEN`: (Optional) Your Telegram bot token if `PUSH_PROVIDER="telegram"`.
- `NTFY_AUTH_TOKEN`: (Optional) Authentication token if your `ntfy` topic is protected.

**Environment Variables (in `wrangler.toml` `[vars]` block)**
- `ENABLE_PUBLIC_DASHBOARD`: `"true"` or `"false"`. If false, visiting the worker route will return a 404 (but background alerts will continue running).
- `ENABLE_CLOUDFLARE_ACCESS`: `"true"` or `"false"`. **WARNING**: If `"false"`, the public dashboard is entirely open to the internet. 
- `NOTIFY_VIA_EMAIL`: `"true"` or `"false"`
- `EMAIL_PROVIDER`: `"resend"`, `"mailchannels"`, `"postmark"`, or `"zeptomail"`
- `ALERT_TO_EMAIL`: The recipient email address for alerts.
- `EMAIL_FROM_ADDRESS`: The sender email address.
- `EMAIL_FROM_NAME`: The sender name (e.g., "Usage Watcher").
- `NOTIFY_VIA_PUSH`: `"true"` or `"false"`
- `PUSH_PROVIDER`: `"telegram"` or `"ntfy"`
- `TELEGRAM_CHAT_ID`: Your Telegram Chat ID.
- `NTFY_TOPIC_URL`: Your full Ntfy topic URL (e.g., `https://ntfy.sh/my_topic`).
- `CF_ACCESS_JWK_URL`: Update `<your-team-name>` to your Zero Trust team name if using Cloudflare Access.
- `CF_ACCESS_AUDIENCE`: The Audience Tag for your Access application.
- `TIME_ZONE`: The local timezone for snapshot timestamps (e.g., `"America/Chicago"`).

## Notes

- The watcher uses Cloudflare's global GraphQL endpoint for analytics queries:
  `https://api.cloudflare.com/client/v4/graphql`

## Supported Providers

**Email (`EMAIL_PROVIDER`)**
- `resend`: (Default) Set `EMAIL_API_KEY` to your Resend API Key.
- `mailchannels`: Free email routing from Cloudflare Workers. No API key required.
- `postmark`: Set `EMAIL_API_KEY` to your Postmark server token.
- `zeptomail`: Set `EMAIL_API_KEY` to your ZeptoMail token.

**Push (`PUSH_PROVIDER`)**
- `telegram`: (Default) Requires `TELEGRAM_BOT_TOKEN` and `TELEGRAM_CHAT_ID`.
- `ntfy`: Requires `NTFY_TOPIC_URL` (e.g. `https://ntfy.sh/my_topic`). Optionally set `NTFY_AUTH_TOKEN` if your topic is protected.

## Disclaimer

**Security Notice:** By default, if `ENABLE_CLOUDFLARE_ACCESS` is set to `"false"`, the public status dashboard built-in to this application will be exposed to the entire internet with no authentication. The code has no built-in password or token security mechanism. You are strongly advised to leave `ENABLE_CLOUDFLARE_ACCESS="true"` and configure a Cloudflare Access Zero Trust policy to securely protect the route.

Cloudflare, Telegram, ZeptoMail, Postmark, Resend, MailChannels, Ntfy, and any other brand names, product names, or service marks mentioned in this document are the trademarks, registered trademarks, or service marks of their respective owners. This open-source project is provided for educational and utility purposes only, and is not affiliated with, endorsed by, or sponsored by Cloudflare, Inc. or any other brand mentioned herein.

**AI Generation Notice:** Portions of this code and its accompanying documentation may have been generated or assisted by Artificial Intelligence (AI). While efforts have been made to ensure accuracy, AI-generated code can contain bugs, security vulnerabilities, or unintended behaviors. You are strongly cautioned to independently review, test, and audit all code and configurations to ensure they meet your specific security, compliance, and production requirements before deployment.
