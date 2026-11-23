# Lookout

Lookout checks HTTP(S) and TCP services every minute. It serves a public WHNet status page, a small summary API, and a read-only private operator view. It runs on Cloudflare Workers with D1 or on a standalone Node process with SQLite.

## Build and release

Run `make` for the command list. Use `make install` to install the locked dependencies and `make check` to run verification. `make build-worker` checks a credential-free Worker build. `make build` builds the self-hosted OCI image. Node 24.15 or newer is required for running from source. Browser verification uses the system Chromium, an executable specified by `PLAYWRIGHT_CHROMIUM_EXECUTABLE`, or Chromium installed with `npx --no-install playwright-core install chromium`.

Set the package and lockfile version with `make version V=0.2.0`. After the version change reaches `main`, tag the reviewed revision with an annotated `v0.2.0` tag and push it. GitLab verifies the protected tag, publishes the Linux `amd64` image in the private project registry, and records its digest in a private GitLab Release.

## Configure checks

Use Node 24.15 or newer and run `npm ci`. [monitors.example.json](monitors.example.json) demonstrates a TCP dependency, HTTP and regex checks, visibility, alert overrides, and the WHNet group. Use it as a template for your live configuration. Store the live JSON in your private D1 database for Cloudflare or in a file outside the checkout for self-hosting. To validate a file, run `npm run validate -- /path/to/monitors.json`. With no path, the command validates the public example.

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
| `defaultGroup`, `allowedOrigins` | Published group for the dashboard banner and unqualified API. Exact browser origins may read the legacy `/api/status` API cross-origin. The public embed API has its own anonymous access policy. |
| `alert`, `alertGroup` | Set `threshold` and `muted` globally, on a group, or on a check. A check inherits from its explicit `alertGroup` before the global defaults. The default threshold is two consecutive failures. |
| `webhook` | Optional `{"format":"json","urlSecret":"LOOKOUT_WEBHOOK_URL"}` or `"format":"discord"`. The named runtime secret contains the destination URL. |

Up to five probes run concurrently. The configuration accepts 25 checks, 40 combined checks and groups, and 45 outbound probe operations per minute including configured redirects. Cloudflare TCP requires a reachable public address and blocks private and loopback addresses, Cloudflare IP ranges, and port 25. A self-hosted instance can use its local network.

On Cloudflare, cron calls a named entry point in the same Worker for sequential batches of up to five probes. Each batch has its own measured invocation CPU. Cron combines the observations, commits the minute to D1, and handles webhook delivery. The standalone process uses the same probe runner directly.

## Self-host

The GitLab Release lists the registry image and its digest. Log in to the private registry and set `IMAGE` to the digest reference from that release, for example `registry.example.com/team/lookout@sha256:…`.

```sh
docker login "$REGISTRY"
docker pull "$IMAGE"
docker run -d --name lookout --restart unless-stopped \
  --publish 127.0.0.1:8787:8787 \
  --mount type=bind,source=/etc/lookout/monitors.json,target=/etc/lookout/monitors.json,readonly \
  --mount type=volume,source=lookout-data,target=/var/lib/lookout \
  "$IMAGE"
```

Give the non-root container user (UID 1000) read access to the config file. Supply optional runtime secrets through a private `--env-file`. The named volume keeps SQLite data across image upgrades and container replacement. Restart the container to apply edits. If your editor replaces the bind-mounted file atomically, recreate the container with the same mount and data volume so it sees the new file.

For a locally built image, run `make run-image LOOKOUT_CONFIG=/absolute/path/to/monitors.json`. Set `IMAGE` for a different tag or digest, `PORT` for a different loopback port, `VOLUME` for a different data volume, or `ENV_FILE` for private runtime settings.

To run directly from a source checkout, use the same external config or set `LOOKOUT_CONFIG` to another file.

```sh
make install
make run
```

Startup validates `/etc/lookout/monitors.json` before opening the listener. Set `LOOKOUT_CONFIG` for a different file. Restart Lookout to apply changes.

The source process defaults to `127.0.0.1:8787`. Set `PORT` or `LOOKOUT_HOST` to change the listen address. Set `LOOKOUT_DB` to keep the SQLite file on persistent storage. Startup applies unapplied migrations, runs the current scheduled minute, and then schedules subsequent minutes.

For the private view, supply `LOOKOUT_PRIVATE_USER` and `LOOKOUT_PRIVATE_PASSWORD`. Terminate HTTPS at a local reverse proxy and set `LOOKOUT_TRUST_PROXY=1` while retaining a loopback listener. For the Linux container, use `--network host --env LOOKOUT_HOST=127.0.0.1` instead of the published port so the proxy can reach that loopback listener. Have the proxy replace `X-Forwarded-Proto` with the verified request scheme. Place these directives in an HTTPS nginx location.

```nginx
proxy_pass http://127.0.0.1:8787;
proxy_set_header X-Forwarded-Proto $scheme;
```

The operator view is at `/private` and uses the browser’s Basic Auth prompt. The public page and summary API use their own visibility projections. Private targets, results, and dependencies remain in the private view. A published group can still reflect the availability of its private members.

`GET /healthz` returns `{ "version": "0.2.0", "revision": "<full-commit-sha>" }` and responds with HTTP 503 when storage is unavailable. A source checkout without configured build metadata can report a `null` revision.

## Cloudflare

Run the local Worker with zero checks, local D1, and an explicit scheduled invocation.

```sh
npm ci
npx wrangler d1 migrations apply DB --local
npm run dev:worker
curl 'http://localhost:8787/cdn-cgi/local/scheduled?format=json'
```

Provision separate D1 databases for staging and production with `npx wrangler d1 create <name>`. The checked-in Wrangler config uses a local placeholder ID. Set these values for both the initial migration and deployment.

| Deployment variable | Value |
| --- | --- |
| `CLOUDFLARE_ACCOUNT_ID` | Account containing the D1 database. |
| `CLOUDFLARE_API_TOKEN` | Scoped token with Workers Scripts and D1 edit permissions. Include the required zone permissions when managing a custom domain. |
| `LOOKOUT_D1_DATABASE_ID` | UUID from D1 provisioning. |
| `LOOKOUT_D1_DATABASE_NAME` | Database name, default `lookout`. |
| `LOOKOUT_WORKER_NAME` | Worker name, default `lookout`. |
| `LOOKOUT_DOMAIN` | Custom domain hostname. Required for production CI. |
| `LOOKOUT_INITIAL_CONFIG_FILE` | Path to a validated JSON file to insert if D1 has no monitor configuration. |

#### Set up and edit the D1 configuration

`make deploy` can apply the initial migrations and seed an empty config table from `LOOKOUT_INITIAL_CONFIG_FILE`. An existing D1 row takes precedence, and later deployments preserve dashboard edits. For manual provisioning of the schema alone, run `make migrate`.

For edits, open **D1 SQL Database** in the Cloudflare dashboard, select the database, and open **Console**. Update the `config_json` column of the `lookout_monitor_config` row with `id = 1`. The statement below creates or replaces the row. Replace the empty example with your service definitions, and double any single quotes inside the SQL string. Save a copy of the previous JSON in private storage before replacing a live config. [D1 dashboard guide](https://developers.cloudflare.com/d1/get-started/)

```sql
INSERT INTO lookout_monitor_config (id, config_json)
VALUES (1, '{"checks":[],"groups":[]}')
ON CONFLICT (id) DO UPDATE SET config_json = excluded.config_json;
```

Each deployment packages one validated D1 snapshot into the Worker version and publishes one UTC cron. An invalid or missing config fails deployment and leaves the live Worker version in place. Supply check header secrets, webhook URLs, and private credentials through the Worker’s runtime secrets. The monitor JSON can reference them by name.

#### Release from GitLab

GitLab verifies the application, browser, and OCI image before releasing. The production job runs after successful pushes and manually started pipelines on protected `main`. Protect `main` and the `v*` tag pattern in the project, enable the private Container Registry, and use a runner with TLS-enabled Docker-in-Docker for the container jobs. Keep GitLab as the production uploader. Disable automatic Workers Builds uploads for this Worker. [GitLab deployment safety](https://docs.gitlab.com/ci/environments/deployment_safety/)

Set the deployment variables above as protected project variables scoped to the `production` environment. Use **File** for `LOOKOUT_INITIAL_CONFIG_FILE` and a masked variable for the Cloudflare API token. The file variable contains the live JSON. Keep actual runtime secret values in Cloudflare. After staging passes, set `LOOKOUT_PRODUCTION_READY=1` as a protected variable at scope `*` and run a pipeline on `main` to activate. The deploy job checks the live source revision and status API after upload. [GitLab file variables](https://docs.gitlab.com/ci/variables/)

For a config-only release, edit the D1 row and run a new `main` pipeline from GitLab. For a rollback, disable production readiness while restoring the prior Worker version in Cloudflare. Restore the corresponding D1 JSON if the config caused the problem, since later deployments read the current row. For a permanent code rollback, revert the application change on `main`. [Worker versions](https://developers.cloudflare.com/workers/versions-and-deployments/)

### Staging release check

Use a separate staging Worker name and D1 database. Seed D1 with 20 representative checks, including full-size regex health bodies, a reachable public TCP target, and two controlled targets in an upstream/dependent relationship. Send notifications to a staging receiver you control. Deploy and set its runtime secrets before starting the check. Update the D1 row and deploy the same source revision again to verify that the new Worker picks up the edit.

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

Create a random fixture token and keep the deployment secret files outside the repository. The fixture receives `LOOKOUT_FIXTURE_TOKEN` as the raw token. Lookout receives `LOOKOUT_FIXTURE_TOKEN` as `Bearer <raw-token>` and `LOOKOUT_WEBHOOK_URL` as `https://<fixture-host>/webhook?token=<url-encoded-raw-token>`. Deploy the fixture with `wrangler deploy --config .artifacts/staging/wrangler.fixture.json --secrets-file <secret-json-file>`. Seed the Lookout D1 configuration row with the generated `.artifacts/staging/monitors.json`, point the deployment variables at the staging Worker and D1 database, and run `npm run deploy`. Install the Lookout runtime secrets before collecting observations.

After the healthy baseline, run the SQL below against the fixture binding, first with `cascade`, then with `dependent`, then with `healthy`. Hold each mode until Lookout records the expected transition. Test the exact configured regexes in staging when they differ materially from the fixture’s marker checks.

~~~sh
npx wrangler d1 execute DB --remote --config .artifacts/staging/wrangler.fixture.json \
  --command "UPDATE fixture_control SET mode = 'cascade' WHERE id = 1"
npm run verify:staging -- <lookout-database-name> <fixture-database-name>
npm run verify:staging:metrics -- <lookout-stage-worker> <lookout-stage-d1-uuid> <from-utc> <through-utc> <version-uuid> 4
~~~

Use the inclusive UTC minute boundaries printed by `verify:staging` and the version ID printed by Wrangler on deploy. Pass the same database name twice when both Workers use it. The metrics reader uses the staging Cloudflare account ID and token and needs Workers Observability Write and Account Analytics Read. It checks four probe batches per scheduled invocation on the same trace and reports separate CPU maxima for cron and the batches. D1 UTC-day totals are adaptive estimates. A shared D1 database’s totals include fixture queries. After collecting the evidence, clear the staging Lookout Worker’s cron trigger to stop the synthetic workload.

## Embed status

Open `/embed` on your status site for examples. Load the module once and add one or more `<lookout-status>` elements. Use `check` for a public check, `group` for a published group, or omit both for the configured default group. The default is a badge. Choose `variant="card"` for a larger card. The child link remains available without JavaScript.

```html
<script type="module" src="https://status.example.com/assets/lookout-status.js"></script>

<lookout-status group="whnet" variant="card" label="WHNet services">
  <a href="https://status.example.com/#group-whnet">WHNet service status</a>
</lookout-status>
```

The element reads `GET /api/v1/status`, with at most one of `?check=ID` and `?group=ID`. Anonymous browser reads are available from any origin. Responses contain `online` and `status` (`operational`, `degraded`, `outage`, or `unknown`). A hidden or missing target returns the same 404 response. The module distinguishes an unavailable request from an unknown status and refreshes while the tab is visible.

If the consumer sets a Content Security Policy, allow the status origin in `script-src`, `style-src`, and `connect-src` for the module, stylesheet, and API. If you host a copy of the module and stylesheet elsewhere, set the element’s `origin` attribute to the Lookout origin. Existing [WHNet chip integrations](examples/whnet-chip.js) use `/api/status` and its `allowedOrigins` policy.

## Alerts and history

A dependency failure holds new downstream alerts while that upstream remains down, including muted upstreams. An upstream outage reports dependents once per incident and sends updates when new impact appears. A dependent that remains down after its upstream recovers can open its own alert. Existing independent outages keep their own recoveries. Public status reflects fresh observations immediately, regardless of the alert threshold.

The generic JSON webhook includes a `delivery_id`, ISO UTC `scheduled_at`, and an `events` array. Events contain `kind` (`outage`, `impact`, or `recovery`), `incidentId`, `check`, `result`, and `affected`. Each request sets `Idempotency-Key` to its delivery ID. Receivers can deduplicate retries by that ID. Discord deliveries use native Discord payloads with mentions disabled.

Current results become unknown at three scheduled minutes old. Daily strips show the current UTC date and previous six dates, and each check detail provides a rolling seven-day minute history. Unobserved periods appear as gaps. Stored results expire after 14 days.

## Verification

```sh
make check
```

The local Worker and standalone smoke tests exercise twenty probes and a webhook cascade against synthetic targets. The browser check uses Chromium, with an optional `PLAYWRIGHT_CHROMIUM_EXECUTABLE` override, and saves desktop, mobile, and brand review images under `.artifacts/browser/`.

## License

Copyright © 2026 Samuel Gagnon. Lookout is licensed under the GNU Affero General Public License, version 3 only. [AGPL-3.0-only](LICENSE)

The footer links to the source for the running Lookout revision. If you deploy a modified version, update the source link to offer the corresponding source for your version. [GNU AGPL guidance](https://www.gnu.org/licenses/gpl-howto.html)

The WHNet mosaic artwork and RE2JS retain their MIT notices. [Mosaic notice](public/assets/whnet-mosaic-LICENSE.txt) · [RE2JS notice](public/assets/re2js-LICENSE.txt)
