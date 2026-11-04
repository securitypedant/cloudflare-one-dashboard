#!/usr/bin/env bash
# Write .dev.vars using the OAuth token from your current `wrangler login`.
# The OAuth token is short-lived; re-run this when /api/traffic starts returning auth errors.
set -euo pipefail
cd "$(dirname "$0")/.."

token=$(npx wrangler auth token 2>/dev/null | tail -1)
if [[ -z "$token" ]]; then
	echo "Could not get a token from wrangler. Run 'npx wrangler login' first." >&2
	exit 1
fi

umask 077
printf 'CLOUDFLARE_API_TOKEN=%s\n' "$token" > .dev.vars
echo "Wrote .dev.vars (token not shown)."
