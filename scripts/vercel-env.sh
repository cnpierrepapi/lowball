#!/usr/bin/env bash
# Loads the shop's production settings into Vercel from the local files, without printing them.
# They take effect on the next deploy (push to main). Never deploy from this folder with the
# CLI: it would upload local files. Run from the repo root: bash scripts/vercel-env.sh
set -euo pipefail
vercel link --yes --project lowball > /dev/null
add() { printf %s "$2" | vercel env add "$1" production --force > /dev/null && echo "set $1"; }
add OFFER_SIGNING_KEY "$(grep '^OFFER_SIGNING_KEY=' .env.local | cut -d= -f2- | tr -d '\r\n')"
add MERCHANT_ADDRESS "$(grep '^MERCHANT_ADDRESS=' .env.local | cut -d= -f2- | tr -d '\r\n')"
add SHOP_KEYPAIR "$(tr -d '\r\n' < .keys/shop.json)"
add MERCHANT_KEYPAIR "$(tr -d '\r\n' < .keys/merchant.json)"
add GOOGLE_VERTEX_CREDENTIALS_B64 "$(tr -d '\r\n' < .keys/vertex.b64)"
add GOOGLE_VERTEX_PROJECT "lowball-shop-102518510"
