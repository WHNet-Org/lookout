# Lookout

Lookout checks HTTP(S) and TCP services every minute. It serves a public WHNet status page, a small summary API, and a read-only private operator view. It runs on Cloudflare Workers with D1 or on a standalone Node process with SQLite.

## Configure checks

Use Node 24.15 or newer and run `npm ci`. Edit [monitors.json](monitors.json) and validate it with `npm run validate`. The committed configuration starts empty. [monitors.example.json](monitors.example.json) demonstrates a TCP dependency, HTTP and regex checks, visibility, alert overrides, and the WHNet group. Replace example targets with your services before deployment.

| Setting | Behavior |
| --- | --- |
| `checks[].id`, `name` | Stable lowercase slug and display name. Reuse an ID for the same service to preserve its history. |
| HTTP `url`, `method`, `expectedCodes` | GET and any 2xx by default. HEAD and explicit status codes are optional. |
| HTTP `bodyRegex` | RE2 search of a complete UTF-8 GET response up to 16 KiB. The deadline covers the whole read. |
| HTTP `headers` | Each value is a literal string or `{"secret":"PROBE_SECRET_NAME"}`. Put credentials in runtime secrets. |
| HTTP `redirects` | Omit to inspect the first response. Set `{"maxHops":2,"allowedOrigins":["https://example.com"]}` to follow redirects. Default hop limit is three. Same-origin redirects and same-host HTTPS upgrades are allowed. All custom headers are removed after an origin change. |
| TCP `host`, `port` | Opens and closes a TCP connection. Successful connection establishment is the result. |
| `timeoutMs` | Defaults to 5000, with a maximum of 8000. Shared across redirects and body reads. |
| `dependsOn` | Required check IDs. Probes continue through outages. Lookout uses simultaneous observations to identify possible cascade impact. |
| `visibility` | Each check starts `private`. Mark it `public` to publish its name and history. |
| `groups[]` | Each group has an ID, name, and `checks` list. Visibility is `private` by default, `detailed` to list its public checks, or `aggregate` to publish only group health and uptime. |
| `defaultGroup`, `allowedOrigins` | Published group for the dashboard banner and unqualified API. Exact browser origins may read the API cross-origin. |
| `alert`, `alertGroup` | Set `threshold` and `muted` globally, on a group, or on a check. A check inherits from its explicit `alertGroup` before the global defaults. The default threshold is two consecutive failures. |
| `webhook` | Optional `{"format":"json","urlSecret":"LOOKOUT_WEBHOOK_URL"}` or `"format":"discord"`. The named runtime secret contains the destination URL. |

Up to five probes run concurrently. The configuration accepts 25 checks, 40 combined checks and groups, and 45 outbound probe operations per minute including configured redirects. Cloudflare TCP requires a reachable public address and blocks private and loopback addresses, Cloudflare IP ranges, and port 25. A self-hosted instance can use its local network.

On Cloudflare, cron calls a named entry point in the same Worker for sequential batches of up to five probes. Each batch has its own measured invocation CPU. Cron combines the observations, commits the minute to D1, and handles webhook delivery. The standalone process uses the same probe runner directly.

## Self-host

```sh
npm ci
npm start
```

The server binds to `127.0.0.1:8787`. Set `PORT`, `LOOKOUT_HOST`, `LOOKOUT_CONFIG`, or `LOOKOUT_DB` to override the port, listen address, config path, or database path. Keep the SQLite file on persistent storage. Startup applies unapplied migrations, runs the current scheduled minute, and then schedules subsequent minutes. Restart after changing config.

For the private view, supply `LOOKOUT_PRIVATE_USER` and `LOOKOUT_PRIVATE_PASSWORD` to the process. Terminate HTTPS at a local reverse proxy and set `LOOKOUT_TRUST_PROXY=1` while retaining a loopback listener. Have the proxy replace `X-Forwarded-Proto` with the verified request scheme. Place these directives in an HTTPS nginx location.

```nginx
proxy_pass http://127.0.0.1:8787;
proxy_set_header X-Forwarded-Proto $scheme;
```

The operator view is at `/private` and uses the browser’s Basic Auth prompt. The public page and summary API use their own visibility projections. Private targets, results, and dependencies remain in the private view. A published group can still reflect the availability of its private members.

## Cloudflare

Run locally with D1 and an explicit scheduled invocation:

```sh
npm ci
npx wrangler d1 migrations apply DB --local
npm run dev:worker
curl 'http://localhost:8787/cdn-cgi/local/scheduled?format=json'
```

Provision separate D1 databases for staging and production with `npx wrangler d1 create <name>`. The checked-in Wrangler file uses a local placeholder ID. The deploy command uses the provisioned values below, applies migrations, and deploys with a single UTC cron.

| Deployment variable | Value |
| --- | --- |
| `CLOUDFLARE_ACCOUNT_ID` | Account containing the D1 database. |
| `CLOUDFLARE_API_TOKEN` | Scoped token with Workers Scripts and D1 edit permissions. Include the required zone permissions when managing a custom domain. |
| `LOOKOUT_D1_DATABASE_ID` | UUID from D1 provisioning. |
| `LOOKOUT_D1_DATABASE_NAME` | Database name, default `lookout`. |
| `LOOKOUT_WORKER_NAME` | Worker name, default `lookout`. |
| `LOOKOUT_DOMAIN` | Optional custom domain hostname. |

Run `npm run deploy` after supplying these variables. Set check header secrets, webhook URLs, and private credentials with `npx wrangler secret put <NAME> --name <worker>`, then redeploy. Protect production credentials in GitLab. After completing staging, set the protected project variable `LOOKOUT_PRODUCTION_READY=1` at environment scope `*` so the deploy rule can see it. Passing revisions on protected `main` deploy automatically. Deployments are serialized and superseded pipeline revisions are skipped. To roll back, revert the application change on `main` and let the pipeline redeploy.

### Staging release check

Use a separate staging Worker name and D1 database. In a staging checkout, configure 20 representative checks, including full-size regex health bodies, a reachable public TCP target, and two controlled targets in an upstream/dependent relationship. Send notifications to a staging receiver you control. Deploy and set its runtime secrets before starting the check.

1. Let the schedule settle and confirm the expected healthy baseline.
2. Force the upstream and dependent to fail together for the configured threshold. Verify one upstream outage with the dependent in its impact list, then restore the upstream and verify a recovery. Leave the dependent failing long enough to open its own alert and then restore it. Save the receiver’s delivery IDs, incident IDs, and event types.
3. Run the check below with staging account credentials. It verifies the latest 15 stored UTC minutes are fresh, consecutive, and each contain 20 results. Run it after the recovery so the logged window includes the cascade.

~~~sh
npm run verify:staging -- lookout-staging
~~~

4. For that UTC window, check the cron invocations and their probe batches in Workers Logs. Verify full coverage, successful outcomes, and CPU headroom under the Free plan’s 10 ms limit. Record D1 rows read and written and confirm account headroom alongside the other databases. Save the window, webhook receipt evidence, and runtime measurements before enabling production.

#### Synthetic staging fixture

You can exercise the entire cascade on dedicated staging resources. Provision a staging D1 database and choose separate `workers.dev` names for Lookout and its fixture. Supply one public TCP endpoint you control.

| Setting | Value |
| --- | --- |
| `LOOKOUT_STAGING_WORKER_NAME` | Dedicated staging Lookout Worker name. |
| `LOOKOUT_STAGING_D1_DATABASE_NAME`, `LOOKOUT_STAGING_D1_DATABASE_ID` | Staging D1 name and UUID. |
| `LOOKOUT_FIXTURE_WORKER_NAME`, `LOOKOUT_FIXTURE_URL` | Fixture Worker name and its HTTPS `workers.dev` origin. |
| `LOOKOUT_STAGING_TCP_HOST`, `LOOKOUT_STAGING_TCP_PORT` | Public TCP host and port for the twentieth probe. |
| `LOOKOUT_FIXTURE_D1_DATABASE_NAME`, `LOOKOUT_FIXTURE_D1_DATABASE_ID` | Optional second D1 database for isolating fixture analytics. Both default to staging D1. |

Run `npm run prepare:staging` with these settings. Use the generated files under `.artifacts/staging` with Wrangler.

~~~sh
npx wrangler d1 migrations apply DB --remote --config .artifacts/staging/wrangler.lookout.json
npx wrangler d1 execute DB --remote --config .artifacts/staging/wrangler.fixture.json \
  --file .artifacts/staging/fixture.sql
~~~

Create a random fixture token and keep the two deployment secret files outside the repository. The fixture receives `LOOKOUT_FIXTURE_TOKEN` as the raw token. Lookout receives `LOOKOUT_FIXTURE_TOKEN` as `Bearer <raw-token>` and `LOOKOUT_WEBHOOK_URL` as `https://<fixture-host>/webhook?token=<url-encoded-raw-token>`. Deploy the fixture first and Lookout second with `wrangler deploy --config <generated-config> --secrets-file <secret-json-file>`.

After the healthy baseline, run the SQL below against the fixture binding, first with `cascade`, then with `dependent`, then with `healthy`. Hold each mode until Lookout records the expected transition. Test the exact configured regexes in staging when they differ materially from the fixture’s marker checks.

~~~sh
npx wrangler d1 execute DB --remote --config .artifacts/staging/wrangler.fixture.json \
  --command "UPDATE fixture_control SET mode = 'cascade' WHERE id = 1"
npm run verify:staging -- <lookout-database-name> <fixture-database-name>
npm run verify:staging:metrics -- <lookout-stage-worker> <lookout-stage-d1-uuid> <from-utc> <through-utc> <version-uuid> 4
~~~

Use the inclusive UTC minute boundaries printed by `verify:staging` and the version ID printed by Wrangler on deploy. Pass the same database name twice when both Workers use it. The metrics reader uses the staging Cloudflare account ID and token and needs Workers Observability Write and Account Analytics Read. It checks four probe batches per scheduled invocation on the same trace and reports separate CPU maxima for cron and the batches. D1 UTC-day totals are adaptive estimates. A shared D1 database’s totals include fixture queries. After collecting the evidence, clear the staging Lookout Worker’s cron trigger to stop the synthetic workload.

## WHNet chip

`GET /api/status?group=whnet` returns `{"online":true,"status":"operational"}` when every check in the published WHNet group is freshly up. The other values are `degraded`, `outage`, and `unknown`. The response exposes only the group state and online flag. Add the WHNet origin to `allowedOrigins` and point the integration at the installed status domain.

```html
<a href="https://status.example.com/"
   data-lookout-summary="https://status.example.com/api/status?group=whnet">
  <span data-lookout-label aria-live="polite">Service status</span>
</a>
<script type="module" src="/lookout-chip.js"></script>
```

Serve [examples/whnet-chip.js](examples/whnet-chip.js) from the consuming site. The anchor works without the module. The module updates while the tab is visible and reports an unavailable state when the API request fails.

## Alerts and history

A dependency failure holds new downstream alerts while that upstream remains down, including muted upstreams. An upstream outage reports dependents once per incident and sends updates when new impact appears. A dependent that remains down after its upstream recovers can open its own alert. Existing independent outages keep their own recoveries. Public status reflects fresh observations immediately, regardless of the alert threshold.

The generic JSON webhook includes a `delivery_id`, ISO UTC `scheduled_at`, and an `events` array. Events contain `kind` (`outage`, `impact`, or `recovery`), `incidentId`, `check`, `result`, and `affected`. Each request sets `Idempotency-Key` to its delivery ID. Receivers can deduplicate retries by that ID. Discord deliveries use native Discord payloads with mentions disabled.

Current results become unknown at three scheduled minutes old. Daily strips show the current UTC date and previous six dates, and each check detail provides a rolling seven-day minute history. Unobserved periods appear as gaps. Stored results expire after 14 days.

## Verification

```sh
npm run validate
npm run typecheck
npm test
npm run test:worker
npm run test:browser
npm run deploy -- --dry-run
```

The local Worker and standalone smoke tests exercise twenty probes and a webhook cascade against synthetic targets. The browser check uses Chromium, with an optional `PLAYWRIGHT_CHROMIUM_EXECUTABLE` override, and saves desktop, mobile, and brand review images under `.artifacts/browser/`.
