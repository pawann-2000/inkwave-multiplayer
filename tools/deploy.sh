#!/bin/sh
# Build dist/ and deploy it to Cloudflare Workers as static assets (wrangler.jsonc: Worker "inkwave-multiplayer").
# One-time setup: `npx wrangler@4.141.0 login`, and the target account in .env (gitignored):
#   CLOUDFLARE_ACCOUNT_ID=<account id from `npx wrangler@4.141.0 whoami`>
# usage: npm run deploy      (verify afterwards: node tools/check-deploy.mjs <url>)
set -e
cd "$(dirname "$0")/.."
if [ -z "$CLOUDFLARE_ACCOUNT_ID" ] && ! grep -qs '^CLOUDFLARE_ACCOUNT_ID=' .env; then
  echo "deploy: set CLOUDFLARE_ACCOUNT_ID in .env (see the header of this script)" >&2
  exit 1
fi
python3 tools/build-dist.py
npx --yes wrangler@4.141.0 deploy
