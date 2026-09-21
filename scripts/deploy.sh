#!/usr/bin/env bash
# One-command production deploy: DB migrations -> API (Render) -> web (Vercel).
# Usage: pnpm deploy:all
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

RENDER_SERVICE_ID="srv-daml9h4ri2ms73eum85g"            # tradesathi-api
export VERCEL_ORG_ID="team_NncTLe3oxCPNF2oLzN37CjQK"
export VERCEL_PROJECT_ID="prj_62IPIYr39H6aGTEi9EfJAYRhYkFA" # web (rootDirectory: apps/web)

step() { printf '\n\033[1;36m==> %s\033[0m\n' "$1"; }

step "Checking working tree"
if [[ -n "$(git status --porcelain)" ]]; then
  echo "Uncommitted changes — commit or stash them first." >&2
  exit 1
fi
BRANCH="$(git rev-parse --abbrev-ref HEAD)"
if [[ "$BRANCH" != "master" ]]; then
  echo "On '$BRANCH' — production deploys run from master." >&2
  exit 1
fi

step "Pushing master to GitHub"
git push origin master
SHA="$(git rev-parse HEAD)"
echo "Deploying $SHA"

step "Applying Supabase migrations"
npx supabase db push

step "Deploying API to Render (waits for the build)"
render deploys create "$RENDER_SERVICE_ID" --commit "$SHA" --wait --confirm -o text

step "Deploying web to Vercel (production)"
# Deployed from the repo root so the build can see packages/shared;
# the project's rootDirectory points Vercel at apps/web.
vercel deploy --prod --yes --cwd "$ROOT"

step "Done — $SHA is live on API and web"
