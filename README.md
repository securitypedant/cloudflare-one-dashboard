# Cloudflare One Dashboard

A per-customer dashboard for Cloudflare One with reports that aren't in dash.cloudflare.com. It runs as one Cloudflare Worker (Static Assets, API, and Logpush ingestion), and each deployment serves a single account behind Cloudflare Access.

Answers: *how much does the size and spread of Cloudflare's network matter for my traffic?*

## Reports (tabs)

| Tab | What it shows | Data |
| --- | --- | --- |
| **Traffic** | Every Cloudflare POP (orange) with traffic circles per POP or shaded countries. Toggle any combination of DNS, HTTP, Network, Bandwidth, Access logins, Users, Devices (each its own colour; concentric circles per POP). Trend vs the previous period per location plus "biggest movers". **Timeline** plays hourly (24h/7d) or daily (30d/90d) frames. | Logpush aggregates, GraphQL fallback |
| **Coverage** | Which POPs serve each user country: a "Users in <country> · N% local" badge per country with arrows to the POPs that served it (green = same country, amber = another country; width = volume). Plus a **comparison with other SASE vendors**: POPs, in-country coverage, share of traffic within 500 km of a vendor POP, and traffic-weighted distance to each vendor's nearest POP. | `coverage_dns` / `coverage_sessions` reports; vendor POPs from [sasecloudmap.com](https://sasecloudmap.com/) |
| **User locations** | Where WARP users actually are (city of their ISP connection, geolocated by Cloudflare) and which POP they connect to: city → POP lines (amber when > 300 km beyond the nearest POP), median distance, per-ISP routing, WARP handshake latency, and a vendor comparison from real user cities. | Logpush `dex_device_state_events` → D1 `user_location_hourly`; city coordinates from GeoNames (CC BY 4.0) |
| **Entry & exit** | Where traffic enters Cloudflare and where it exits when different (e.g. dedicated egress), on-ramps (WARP, Magic Tunnel, …) and off-ramps, **CNI facilities** with v1/v2 dataplanes, and a **Regional Services check** (entry POPs outside a selected managed region). | `entry_exit` report, `shared/cni.ts`, `shared/regions.ts` |
| **Performance** | Client → Cloudflare TCP handshake by entry POP or user country (green < 20 ms … red ≥ 100 ms), plus **DEX** HTTP test duration/failure rate and WARP handshake latency. | `perf_pop` / `perf_country` reports; DEX from Logpush |
| **Security** | Blocked DNS / HTTP / network traffic, DLP matches and AV-blocked files by country or POP, with block rate per location, top blocked DNS categories and top DNS categories (per country when selected). | `sec_*` reports; category names from the Gateway categories API |

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
                                 ingested_objects, logpush_sources
```

- Raw logs expire from R2 after 30 days (lifecycle rule `expire-raw-logpush`). The D1 aggregates are kept.
- Ingestion status: `GET /api/logpush/status`.
- Dataset-to-field mapping: `LOGPUSH_SOURCES` in `worker/logpush.ts`.

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
- Responses are cached by [Workers Cache](https://developers.cloudflare.com/workers/cache/): 2 minutes for Logpush answers, 5–60 minutes for GraphQL. Errors are not cached.

## Generated data

```shell
node scripts/gen-extra-colos.mjs   # worker/data/extraColos.ts: POPs missing from the speed test list, at their airport (OurAirports)
node scripts/gen-cni.mjs           # shared/cni.ts: Direct CNI facilities (v1/v2) from the Cloudflare docs
node scripts/gen-cities.mjs        # worker/data/cities.ts: GeoNames cities15000 for placing DEX user cities (needs `unzip`)
```

Regional Services regions (`shared/regions.ts`) are the country-based managed regions from the [region support](https://developers.cloudflare.com/data-localization/region-support/) page. Certification-based regions (FedRAMP, IRAP, ISO 27001), US state regions and custom regions aren't modelled.

## Layout

```
worker/index.ts      fetch (API) + queue (Logpush ingestion) handlers
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
npm run dev:token   # writes .dev.vars using your wrangler OAuth token (re-run on 401s; other wrangler commands rotate it)
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
2. Set `CLOUDFLARE_ACCOUNT_ID` in `wrangler.jsonc` and store an **account API token** with **Account Analytics: Read** and **Zero Trust: Read** (category names):
   `npx wrangler secret put CLOUDFLARE_API_TOKEN`
3. `npm run deploy`
4. Create the Logpush jobs (above).
5. Expose it only through a custom domain protected by a Cloudflare Access application (`routes` in `wrangler.jsonc`; create the Access application first). `workers_dev` and `preview_urls` stay off. The API returns the account's analytics and shares responses through Workers Cache.

## Data attributions

- City coordinates: [GeoNames](https://www.geonames.org/) cities15000, CC BY 4.0.
- Airport coordinates for data centers missing from the speed test list: [OurAirports](https://ourairports.com/data/), public domain.
- Country shapes: [world-atlas](https://github.com/topojson/world-atlas) (Natural Earth, public domain).
- Country centroids: Google DSPL canonical countries table.
- Other SASE vendors' POP locations: [sasecloudmap.com](https://sasecloudmap.com/) ([data repo](https://github.com/connectivitymaps/sasecloudmap-data)).
- CNI facilities and Regional Services regions: [Cloudflare docs](https://developers.cloudflare.com/).

## License

[MIT](LICENSE)
