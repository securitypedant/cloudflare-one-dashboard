#!/usr/bin/env bash
# Write .dev.vars for local development.
#
# Preferred: a scoped API token (Account Analytics: Read + Zero Trust: Read on the dashboard account):
#   DASHBOARD_API_TOKEN=<token> npm run dev:token
# Fallback: the OAuth token from your current `wrangler login`. It carries your full account
# permissions and is short-lived (re-run when /api/* starts returning auth errors).
set -euo pipefail
cd "$(dirname "$0")/.."

if [[ -n "${DASHBOARD_API_TOKEN:-}" ]]; then
	token="$DASHBOARD_API_TOKEN"
	kind="scoped API token"
else
	token=$(npx wrangler auth token 2>/dev/null | tail -1)
	kind="wrangler OAuth token (broad permissions; prefer DASHBOARD_API_TOKEN)"
	if [[ -z "$token" ]]; then
		echo "Could not get a token from wrangler. Run 'npx wrangler login' first, or set DASHBOARD_API_TOKEN." >&2
		exit 1
	fi
fi

umask 077
{
	printf 'CLOUDFLARE_API_TOKEN=%s\n' "$token"
	# Local dev only: skip the Access JWT check for localhost requests.
	printf 'ALLOW_UNAUTHENTICATED=true\n'
} > .dev.vars
echo "Wrote .dev.vars using a $kind (token not shown)."
