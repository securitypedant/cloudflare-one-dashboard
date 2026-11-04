# AGENTS.md

Cloudflare One customer dashboard: a single Worker (Vite + React + `@cloudflare/vite-plugin`, Static Assets) that serves one account per deployment. It has a `fetch` handler for the UI/API and a `queue` handler that ingests Logpush files from R2 into D1. See README.md for features, data sources, and the ingestion pipeline.

## Commands

```shell
npm run dev:token   # .dev.vars (DASHBOARD_API_TOKEN=<scoped token> preferred; else wrangler OAuth token, rotated by other wrangler commands) + ALLOW_UNAUTHENTICATED=true
npm run dev         # vite dev server, http://localhost:5173 (local D1; GraphQL views hit the real account)
npm test            # vitest (vitest.config.ts; does not load the Cloudflare plugin)
npm run typecheck   # tsc -b (app, worker, node projects)
npm run lint        # oxlint
npm run build
npx wrangler types  # after changing wrangler.jsonc vars/bindings
npx wrangler d1 migrations apply cf1-dashboard --remote   # after adding a migration
```

## Conventions

- Shared contract: `shared/types.ts` (types, `DATASETS` metadata, `unavailableReason`, `REPORT_IDS`). The UI and Worker both import it.
- UI: one component per tab in `src/views/`; `TrafficMap` is the shared map (circles, country fill via feature-state, lines, markers). Fetch with `useApi` (`src/lib/api.ts`). Map popups are HTML strings: always `escapeHtml` data.
- Traffic map read path (`worker/traffic.ts`): Logpush aggregates from D1 when `isCovered`, otherwise GraphQL (`LAYER_QUERIES`). `offset=1` = previous period (trends); `/api/timeline` = per-bucket frames.
- Other reports: add a spec to `REPORTS` (`worker/reports.ts`) and its id to `REPORT_IDS`; never build GraphQL from request input.
- Distinct counts (`uniq`) can't be summed across locations or split windows (take the max); averages are merged weighted, or stored as n + total (`metric_hourly`).
- Generated data: `node scripts/gen-extra-colos.mjs`, `node scripts/gen-cni.mjs`. Don't hand-edit `worker/data/extraColos.ts` or `shared/cni.ts`.
- Logpush (`worker/logpush.ts`): `LOGPUSH_SOURCES` maps Logpush datasets/fields to dashboard aggregates. Object keys must be `logpush/<dataset>/...log.gz`. Each object is ingested in one D1 batch together with its `ingested_objects` row; keep that atomicity so ingestion stays exactly-once.
- GraphQL: before adding fields, verify them by schema introspection (`__type(name: "AccountCf1GatewayDns1dGroupsDimensions")`) and node limits (`viewer.accounts.settings.<node> { maxDuration notOlderThan }`). For Logpush fields, use https://developers.cloudflare.com/logs/logpush/logpush-job/datasets/account/. Don't guess field names.
- One GraphQL query per view, with `X-Rate-Limit-Type: account-based`. Don't batch datasets into one request (per-request read cap); `fetchSplittingWindow` handles that cap.
- Worker imports use explicit `.ts` extensions (`module: nodenext`); `erasableSyntaxOnly` forbids constructor parameter properties.
- `workers_dev` and `preview_urls` are off. Don't enable public URLs unless the Worker is behind Cloudflare Access.
- Never commit `.dev.vars`, and never print tokens.
- Security invariants (see README "Security model"): every `/api/*` route runs after `authorize()` (Access JWT, fail closed); parse params only with `parseParams` (rejects unknown/duplicate); cache results only via `cached()`/`cachedValue()` (after auth; responses stay `private, no-store`); return `apiError(code)`, never raw upstream/D1 messages; read upstream bodies with `readJson(res, maxBytes)` and validate before caching; build popups as `PopupContent` (no HTML strings, no `setHTML`); keep ingestion `LIMITS` and `READ_LIMITS`.
- Admin data: call `requireAdmin()` and cache with `scoped(path)` (admin and viewer results never share a cache key); shared endpoints must omit user-level fields for viewers. Wrap each REST/GraphQL read in `section()` so a missing token permission degrades to a message, not a failed page. User emails need the `Zero Trust: PII Read` permission (otherwise `REDACTED`).
- Data generators pin input hashes in `scripts/data-sources.lock.json`; re-run with `--update` only after reviewing upstream changes.
- `wrangler.jsonc` is gitignored (account ID, D1 ID, domain). Structural config changes go in both `wrangler.jsonc` and `wrangler.example.jsonc`. Generate types with `npm run cf-typegen` (`--strict-vars=false`, so no account values end up in `worker-configuration.d.ts`).
