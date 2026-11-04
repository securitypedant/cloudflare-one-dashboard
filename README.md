# Cloudflare One Dashboard

A per-customer dashboard for Cloudflare One with reports that aren't in dash.cloudflare.com. It runs as one Cloudflare Worker (Static Assets, API, and Logpush ingestion), and each deployment serves a single account behind Cloudflare Access.

Answers: *how much does the size and spread of Cloudflare's network matter for my traffic?*

## Reports (tabs)

Tabs are grouped into **Network**, **Security** and **Admin**. The Admin group, and user-level detail elsewhere, is only shown to members of an `ADMIN_GROUPS` group (see Security model).

| Tab | What it shows | Data |
| --- | --- | --- |
| **Traffic** | Every Cloudflare POP (orange) with traffic circles per POP or shaded countries. Toggle any combination of DNS, HTTP, Network, Bandwidth, Access logins, Users, Devices (each its own colour; concentric circles per POP). Trend vs the previous period per location plus "biggest movers". **Timeline** plays hourly (24h/7d) or daily (30d/90d) frames. | Logpush aggregates, GraphQL fallback |
| **Coverage** | Which POPs serve each user country: a "Users in <country> · N% local" badge per country with arrows to the POPs that served it (green = same country, amber = another country; width = volume). Plus a **comparison with other SASE vendors**: POPs, in-country coverage, share of traffic within 500 km of a vendor POP, and traffic-weighted distance to each vendor's nearest POP. | `coverage_dns` / `coverage_sessions` reports; vendor POPs from [sasecloudmap.com](https://sasecloudmap.com/) |
| **User locations** | Where WARP users actually are (city of their ISP connection, geolocated by Cloudflare) and which POP they connect to: city → POP lines (amber when > 300 km beyond the nearest POP), median distance, per-ISP routing, WARP handshake latency, and a vendor comparison from real user cities. | Logpush `dex_device_state_events` → D1 `user_location_hourly`; city coordinates from GeoNames (CC BY 4.0) |
| **Entry & exit** | Where traffic enters Cloudflare and where it exits when different (e.g. dedicated egress), on-ramps (WARP, Magic Tunnel, …) and off-ramps, **CNI facilities** with v1/v2 dataplanes, and a **Regional Services check** (entry POPs outside a selected managed region). | `entry_exit` report, `shared/cni.ts`, `shared/regions.ts` |
| **Performance** | Client → Cloudflare TCP handshake by entry POP or user country (green < 20 ms … red ≥ 100 ms), plus **DEX** HTTP test duration/failure rate and WARP handshake latency. | `perf_pop` / `perf_country` reports; DEX from Logpush |
| **Security** | Blocked DNS / HTTP / network traffic, DLP matches and AV-blocked files by country or POP, with block rate per location, top blocked DNS categories and top DNS categories (per country when selected). | `sec_*` reports; category names from the Gateway categories API |
| **Threats & data** | Blocked security-risk categories (malware, phishing, C2, …), Shadow IT (SaaS apps in use with their review status, requests and uploaded bytes), DLP matches by destination, malware blocked by antivirus/sandbox. Admins also see the most targeted users and per-user attribution. | Gateway DNS/HTTP analytics; Gateway categories and app types APIs |
| **Identity** | Access logins per day, by country, identity provider and application (success vs failure). Admins also get a user table (logins, failures, devices, last login), seat counts with inactive seats to reclaim, and applications with no logins. | Access login analytics; Access users and applications APIs |
| **Posture** (admin) | Configuration score and ranked findings: Bypass / Everyone policies, missing Access-enforced MFA, long sessions, expiring/unused service tokens, disabled or never-matched Gateway rules, allow-all rules above blocks, TLS inspection/AV/logging off, weak WARP device settings, split tunnels excluding all traffic. Gateway rule match counts (30 days). | Access, Gateway and device settings APIs; Gateway analytics |
| **Devices** (admin) | Enrolled devices, OS mix, WARP client versions (outdated = more than two releases behind the newest in the fleet), devices not seen in 30+ days, posture checks configured. | Devices and device posture APIs |
| **Tunnels** (admin) | Cloudflare Tunnel status and connector versions, Magic WAN tunnel health (24h), with connectors drawn on the map at their POPs. | Cloudflare Tunnel API; Magic WAN health-check analytics |
| **Changes** (admin) | Audit log with full-text search, facet filters (actor, action, resource, interface, result), sortable columns, a per-day chart that filters the table, a Zero Trust-only toggle, and before/after diffs. | Audit logs API |
| **User lookup** (admin) | One user's profile, devices, sign-ins, countries, POPs, blocked categories, top destinations and DLP/AV counts. User names anywhere in the dashboard link here. | Access users/devices APIs; Access and Gateway analytics |

Data center coverage: POPs come from `speed.cloudflare.com/locations`, plus data centers missing from it (e.g. MEX) placed at their airport (`worker/data/extraColos.ts`). POP tiers (T1–T3) aren't included: there's no public source.

## Data sources

**Traffic map views** use **Logpush aggregates in D1** when Logpush fully covers the window, otherwise the **GraphQL Analytics API**. Logpush covers a window when ingestion for that dataset started before the window began and the newest record is less than 2 hours old. The dataset cards show which source was used.

| Traffic type | By POP | By user location |
| --- | --- | --- |
| Gateway DNS | Logpush `gateway_dns.ColoCode` | Logpush `gateway_dns.SrcIPCountryCode` |
| Gateway HTTP | GraphQL only (`gatewayL7RequestsAdaptiveGroups.coloCode`, max 30 days) | Logpush `gateway_http.SourceIPCountryCode` |
| Gateway Network | Logpush `zero_trust_network_sessions.IngressColoName` (sessions) | Logpush `gateway_network.SourceIPCountryCode` |
| Network bandwidth | Logpush `zero_trust_network_sessions` (`BytesReceived + BytesSent`) | GraphQL only |
| Access logins | not recorded anywhere | Logpush `access_requests.Country` |
| Users / Devices | GraphQL only (distinct counts from `cf1GatewayDns*` `uniq`) | GraphQL only |

**Coverage, Entry & exit, Performance (TCP) and Security** use whitelisted GraphQL reports (`REPORTS` in `worker/reports.ts`, served by `/api/report?id=&range=`), which have 90 days of history. **DEX** only comes from Logpush (there is no GraphQL DEX dataset).

Traffic with an unknown country (for example from Tunnel / WAN on-ramps) is reported as "no source location" rather than placed on the map.

### Logpush ingestion pipeline

```
Logpush jobs ──▶ R2 cf1-dashboard-logs/logpush/<dataset>/<YYYYMMDD>/*.log.gz
                  │  (event notification: object-create, prefix logpush/, suffix .log.gz)
                  ▼
               Queue cf1-dashboard-logpush ──(5 retries)──▶ DLQ cf1-dashboard-logpush-dlq
                  │
                  ▼
               Worker queue handler: stream-gunzip NDJSON, aggregate per hour/dataset/POP/country
                  │  one D1 transaction per object (aggregates + ingested_objects row ⇒ exactly once)
                  ▼
               D1 cf1-dashboard: traffic_hourly (counts/sums), metric_hourly (DEX averages as n + total),
                                 user_location_hourly (city × ISP × POP, no IPs or device IDs),
                                 ingested_objects, logpush_sources, dead_letters
```

- Notifications are accepted only for create actions (`PutObject`, `CopyObject`, `CompleteMultipartUpload`) on the bucket named in `LOGPUSH_BUCKET`, and only for keys `logpush/<supported dataset>/….log.gz`. Restrict write access to the bucket to the Logpush R2 token: anything that can write there can add data to the dashboard.
- Ingestion limits (`LIMITS` in `worker/logpush.ts`): 256 MiB compressed object, 2 GiB decompressed, 1 MiB per line, 100k distinct aggregate rows per object, 128 characters per key string. An object over a limit is rejected without retries and recorded in `dead_letters`.
- Retention: a daily cron (`17 3 * * *`) deletes hourly aggregates older than `RETENTION_DAYS` (default 400), `ingested_objects` rows older than 45 days, and dead letters older than 90 days, and moves `logpush_sources.first_record` forward to the cutoff. Raw logs expire from R2 after 30 days (lifecycle rule `expire-raw-logpush`).
- Ingestion status: `GET /api/logpush/status` (coverage per dataset plus the dead-letter count).
- Dataset-to-field mapping: `LOGPUSH_SOURCES` in `worker/logpush.ts`.

### Replaying failed objects

Objects that exhausted their queue retries (consumed from `cf1-dashboard-logpush-dlq`) or were rejected by a limit are listed in D1:

```shell
npx wrangler d1 execute cf1-dashboard --remote --command "SELECT key, reason, attempts, datetime(received_at, 'unixepoch') FROM dead_letters ORDER BY received_at DESC"
```

After fixing the cause, re-trigger ingestion by re-writing the object, which fires a new event notification. Failed objects were never recorded in `ingested_objects`, so they are not treated as duplicates:

```shell
npx wrangler r2 object get cf1-dashboard-logs/<key> --file /tmp/obj.log.gz --remote
npx wrangler r2 object put cf1-dashboard-logs/<key> --file /tmp/obj.log.gz --remote
npx wrangler d1 execute cf1-dashboard --remote --command "DELETE FROM dead_letters WHERE key = '<key>'"
```

### Create the Logpush jobs (Cloudflare dashboard)

Create one job per dataset in **Cloudflare One → Insights → Logs → Manage Logpush → Create a Logpush job**. Job names are free-form (e.g. `cf1-dashboard-gateway-dns`).

1. Destination: **R2 Object Storage** (custom).
   - Bucket: `cf1-dashboard-logs`
   - Path: `logpush/<dataset>`. Must match exactly: the Worker reads the dataset name from the path.
   - Enable **Organize logs into daily subfolders**.
   - Authentication: an R2 API token with **Object Read & Write** on `cf1-dashboard-logs`.
2. Dataset and fields (send only these):

   | Dataset | Path | Fields |
   | --- | --- | --- |
   | Gateway DNS | `logpush/gateway_dns` | `Datetime`, `ColoCode`, `SrcIPCountryCode` |
   | Gateway HTTP | `logpush/gateway_http` | `Datetime`, `SourceIPCountryCode` |
   | Gateway Network | `logpush/gateway_network` | `Datetime`, `SourceIPCountryCode` |
   | Zero Trust Network Sessions | `logpush/zero_trust_network_sessions` | `SessionStartTime`, `IngressColoName`, `BytesReceived`, `BytesSent` |
   | Access Requests | `logpush/access_requests` | `CreatedAt`, `Country` |
   | DEX Application Tests | `logpush/dex_application_tests` | `Timestamp`, `TestType`, `ColoCode`, `HTTPClientIPCountryISO`, `HTTPRequestStartMs`, `HTTPResponseEndMs`, `HTTPStatusCode`, `HTTPErrorMessage` |
   | DEX Device State Events | `logpush/dex_device_state_events` | `Timestamp`, `WarpColoCode`, `ISPIPv4CountryISO`, `HandshakeLatencyMs`, `ISPIPv4City`, `ISPIPv4StateISO`, `ISPIPv4ASO` |

3. Advanced options: timestamp format **RFC3339**, no sampling.

Logpush pricing: the first 25 GB per month to R2 is included, then $0.03/GB ([pricing](https://developers.cloudflare.com/logs/logpush/pricing/)). R2 storage is billed separately.

### GraphQL limits

- One GraphQL query per view, fetched only when needed, using [account-based rate limiting](https://developers.cloudflare.com/analytics/graphql-api/account-based-rate-limiting/).
- If a query "would read too much data", the window is split in half on rollup boundaries, up to 16 sub-windows.
- Results are cached in the colo's Cache API by the Worker itself, after the Access check: 2 minutes for Logpush answers, 5–60 minutes for GraphQL, 24 hours for POPs, vendors and categories. Responses to browsers are `private, no-store`, and errors are not cached.
- Query parameters are strictly validated: unknown or duplicate parameters return 400, so the cache key can't be varied to force fresh GraphQL queries.
- After a rate-limit response, GraphQL calls stop for 60 seconds (circuit breaker) and the API returns `rate_limited`.

## Security model

- **Authentication:** every `/api/*` request must carry a valid Cloudflare Access JWT (`Cf-Access-Jwt-Assertion` header or `CF_Authorization` cookie) for the application set in `ACCESS_TEAM_DOMAIN` / `ACCESS_AUD`. The signature, issuer, audience and expiry are verified against the team's published keys. If either var is missing, the API fails closed (`misconfigured`). `ALLOW_UNAUTHENTICATED=true` (only in `.dev.vars`) skips the check for `localhost` requests and has no effect on any other hostname.
- **Roles:** the viewer's role comes from their Access identity (`/cdn-cgi/access/get-identity`, cached 5 minutes per token). Members of a group listed in `ADMIN_GROUPS` (name, email or id) are admins; everyone else is a viewer, including when the identity can't be read. Admin endpoints (`/api/posture`, `/api/devices`, `/api/tunnels`, `/api/changes`, `/api/users`, `/api/user`) return 403 to viewers, and admin responses are cached under a separate key so they're never served to viewers. Shared endpoints (`/api/identity`, `/api/threats`) omit user-level fields for viewers.
- **Errors:** responses carry fixed codes (`bad_request`, `unauthorized`, `misconfigured`, `rate_limited`, `upstream_error`). Upstream and D1 error text goes to Worker logs only.
- **Upstream data:** responses from speed.cloudflare.com, sasecloudmap.com and the Cloudflare API are read with byte limits, validated, and only the validated result is cached. Vendor lists are fetched with at most 3 requests in flight.
- **UI:** map popups are built with DOM APIs (no HTML strings). `public/_headers` sets a CSP (`default-src 'self'`, `frame-ancestors 'none'`), `X-Content-Type-Options`, `X-Frame-Options`, `Referrer-Policy` and `Permissions-Policy`.
- **Local dev:** `vite.config.ts` denies `.dev.vars*` and `wrangler.jsonc` (in addition to Vite's defaults) so the dev server never serves them.

## Generated data

```shell
node scripts/gen-extra-colos.mjs   # worker/data/extraColos.ts: POPs missing from the speed test list, at their airport (OurAirports)
node scripts/gen-cni.mjs           # shared/cni.ts: Direct CNI facilities (v1/v2) from the Cloudflare docs
node scripts/gen-cities.mjs        # worker/data/cities.ts: GeoNames cities15000 for placing DEX user cities (needs `unzip`)
```

Inputs are hash-pinned in `scripts/data-sources.lock.json`: if upstream data changed, the generator stops. Review the change, then re-run with `--update` to accept it.

Regional Services regions (`shared/regions.ts`) are the country-based managed regions from the [region support](https://developers.cloudflare.com/data-localization/region-support/) page. Certification-based regions (FedRAMP, IRAP, ISO 27001), US state regions and custom regions aren't modelled.

## Layout

```
worker/index.ts      fetch (API), queue (Logpush ingestion + DLQ) and scheduled (retention) handlers
worker/access.ts     Cloudflare Access JWT verification
worker/http.ts       strict parameter parsing, error codes, response headers, post-auth result cache
worker/upstream.ts   byte-limited JSON reads, validated-value cache, bounded concurrency
worker/rbac.ts       roles from the Access identity (ADMIN_GROUPS)
worker/cfapi.ts      Cloudflare REST client; per-section missing-permission reporting
worker/admin/        posture, identity, devices, tunnels, threats, changes (audit log), users
worker/logpush.ts    Logpush field mapping, streaming aggregation, D1 writes/reads, coverage
worker/traffic.ts    traffic map: hybrid read path, previous-period offsets, timeline frames
worker/reports.ts    whitelisted GraphQL reports (/api/report)
worker/dex.ts        DEX averages from D1 (/api/dex)
worker/vendors.ts    SASE vendor POPs from sasecloudmap.com (/api/vendors)
worker/categories.ts Gateway category names (/api/categories)
migrations/          D1 schema
shared/              types, dataset metadata, country centroids, CNI sites, Regional Services regions
src/views/           one component per tab
src/lib/             API hook, geo helpers (point-in-country, distance, arcs), coverage/vendor scoring, stats
scripts/             dev-token.sh and data generators
```

## Development

```shell
npm install
cp wrangler.example.jsonc wrangler.jsonc   # then fill in <YOUR_ACCOUNT_ID>, <YOUR_D1_DATABASE_ID> and the domain
DASHBOARD_API_TOKEN=<scoped token> npm run dev:token   # writes .dev.vars (without the var it falls back to your broad wrangler OAuth token)
npm run dev         # http://localhost:5173 (local D1; GraphQL views use the real account)
npm test
npm run typecheck
npm run lint
```

The Wrangler OAuth token has no Zero Trust scope, so category names show as IDs locally. R2 event notifications only fire for the deployed Worker, so ingestion runs only in production. To read the production D1 locally, add `"remote": true` to the D1 binding; the remote proxy runs on the account's workers.dev subdomain, so if that is behind Access it also needs `CLOUDFLARE_ACCESS_CLIENT_ID` / `CLOUDFLARE_ACCESS_CLIENT_SECRET`.

## Deploy (per customer)

1. `cp wrangler.example.jsonc wrangler.jsonc` (gitignored). Create the resources (names in the config): R2 bucket, queue + DLQ, D1 database (put its ID in `wrangler.jsonc`), then:
   ```shell
   npx wrangler r2 bucket create cf1-dashboard-logs
   npx wrangler queues create cf1-dashboard-logpush && npx wrangler queues create cf1-dashboard-logpush-dlq
   npx wrangler d1 create cf1-dashboard
   npx wrangler d1 migrations apply cf1-dashboard --remote
   npx wrangler r2 bucket notification create cf1-dashboard-logs --event-type object-create --queue cf1-dashboard-logpush --prefix logpush/ --suffix .log.gz
   npx wrangler r2 bucket lifecycle add cf1-dashboard-logs expire-raw-logpush logpush/ --expire-days 30 --force
   ```
2. Create the Cloudflare Access application for the dashboard hostname first. Then set `CLOUDFLARE_ACCOUNT_ID`, `ACCESS_TEAM_DOMAIN` (`<team>.cloudflareaccess.com`) and `ACCESS_AUD` (the application's Audience tag) in `wrangler.jsonc`. Store an **account API token** (`npx wrangler secret put CLOUDFLARE_API_TOKEN`) with:
   - **Account Analytics: Read**: all analytics.
   - **Zero Trust: Read**: categories, Gateway rules/settings, apps, devices, device settings and posture.
   - **Zero Trust: PII Read**: user emails in analytics (otherwise shown as `REDACTED`, and per-user views are unavailable).
   - **Access: Apps and Policies Read**, **Access: Service Tokens Read**, **Access: Organizations, Identity Providers, and Groups Read**: posture checks and app names.
   - **Cloudflare Tunnel Read**: tunnel health.
   - **Account Settings Read**: audit log (Changes tab).

   Each section reports the permission it's missing instead of failing the page. Set `ADMIN_GROUPS` to the group(s) that should get the admin view.
3. `npm run deploy`
4. Create the Logpush jobs (above).
5. Serve it only through the Access-protected custom domain (`routes` in `wrangler.jsonc`). `workers_dev` and `preview_urls` stay off. The Worker also verifies the Access JWT itself, so a missing or misconfigured Access application fails closed instead of exposing data.

## Data attributions

- City coordinates: [GeoNames](https://www.geonames.org/) cities15000, CC BY 4.0.
- Airport coordinates for data centers missing from the speed test list: [OurAirports](https://ourairports.com/data/), public domain.
- Country shapes: [world-atlas](https://github.com/topojson/world-atlas) (Natural Earth, public domain).
- Country centroids: Google DSPL canonical countries table.
- Other SASE vendors' POP locations: [sasecloudmap.com](https://sasecloudmap.com/) ([data repo](https://github.com/connectivitymaps/sasecloudmap-data)).
- CNI facilities and Regional Services regions: [Cloudflare docs](https://developers.cloudflare.com/).

## License

[MIT](LICENSE)
