# ChartAnalyzer

## What this is
A web app that analyzes trading chart screenshots using AI and returns
pattern detection, support/resistance levels, and a directional call.
This file governs how Claude Code should work in this repo.

## Structure
- `apps/web` — Angular 22 (standalone, SSR). User-facing app.
- `apps/api` — Node.js + TypeScript + Express. All secrets and
  third-party calls (Supabase service role, OpenAI, Razorpay) live
  here, never in `apps/web`.
- `packages/shared` — reusable TypeScript types only. No logic, no
  framework-specific code. Both apps depend on it via
  `workspace:*`.
- `supabase/` — Supabase Cloud project config and migrations.
  Supabase is managed/cloud, not self-hosted.

## Philosophy
- MVP-first. Build the smallest thing that works, then extend.
- No premature abstractions — don't add a pattern, layer, or
  generalization until at least two real call sites need it.
- Do not add product features, dependencies, or scope beyond what
  was explicitly asked for in the current task.

## Backend conventions
- Routes (`src/routes`) stay thin: parse input, call a service,
  return a response. No business logic in a route handler.
- Business logic lives in `src/services`.
- Scheduled/background work lives in `src/jobs`.
- Shared low-level helpers (env loading, logging, clients) live in
  `src/lib`.
- Webhook handlers must verify signatures over the raw request body
  — mount raw body parsing before any JSON body parser on those
  routes specifically.
- Money is always stored and passed as integer minor units (paise),
  never as a float.

## Migrations
- Before naming a new migration file, run `npx supabase migration
  list` and give the new file a timestamp later than the newest entry
  shown. Do not trust this machine's `date -u` output — it has been
  found out of sync with the migration sequence.

## TypeScript
- `strict: true` everywhere. No `any` without a comment explaining
  why it's unavoidable.
- Shared domain types go in `packages/shared`, not duplicated across
  apps.

## Secrets
- Never commit real secrets. `.env` stays gitignored; only
  `.env.example` is tracked, with empty placeholder values.
- `SUPABASE_SERVICE_ROLE_KEY`, `OPENAI_API_KEY`, and Razorpay keys
  are used only in `apps/api`, never sent to or read by `apps/web`.

## When in doubt
Ask before assuming scope. If a task doesn't explicitly ask for a
feature, schema change, or new dependency, don't add it — flag it
instead.
