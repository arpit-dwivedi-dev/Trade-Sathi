# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is
A web app that analyzes trading chart screenshots using AI and returns
pattern detection, support/resistance levels, and a directional call.

## Commands
This is a pnpm workspace monorepo (Node >=22, pnpm). Run from the repo root
unless noted.
- `pnpm install` — install all workspace deps.
- `pnpm dev` — run web + api together (concurrently).
- `pnpm dev:web` — Angular dev server only (`apps/web`, `ng serve`).
- `pnpm dev:api` — API only, with reload (`apps/api`, `tsx watch`).
- `pnpm build` — build all packages (`pnpm -r build`).
- `pnpm lint` — eslint across the whole repo (flat config, type-aware
  where a tsconfig covers the file).
- `pnpm test` — run tests in every package that defines one.
  - `apps/api`: `pnpm --filter @chartanalyzer/api test` runs vitest
    (`vitest run`). Run a single file with
    `pnpm --filter @chartanalyzer/api exec vitest run <path>`.
  - `apps/web`: `pnpm --filter @chartanalyzer/web test` runs `ng test`
    (vitest under the hood). Playwright e2e specs live in
    `apps/web/e2e`, config in `apps/web/playwright.config.ts`.
- `npx supabase migration list` — check applied/pending migrations
  before naming a new one (see Migrations below).
- `pnpm gen:disposable-domains` — regenerates the disposable-email-domain
  seed migration from the `disposable-email-domains` package
  (`scripts/generate-disposable-domains-migration.mjs`).

## Structure
- `apps/web` — Angular 22 (standalone, SSR). User-facing app.
  - `src/app/core` — cross-cutting singletons: `auth.service.ts`,
    `auth.guard.ts`, `supabase-client.ts` (browser Supabase client,
    anon key only), `theme.service.ts`.
  - `src/app/features/*` — one folder per feature area (`landing`,
    `auth`, `app`, `analyze`, `account`, `billing`, `history`),
    each routed via `app.routes.ts`.
  - `src/app/shared` — reusable presentational pieces used across
    features.
  - `src/styles/tokens.css` — design tokens; `src/styles/components.css`
    — shared component styles.
  - SSR entry points: `src/main.server.ts`, `src/server.ts`
    (Express server that serves the SSR bundle, distinct from
    `apps/api`).
- `apps/api` — Node.js + TypeScript + Express. All secrets and
  third-party calls (Supabase service role, OpenAI, Razorpay) live
  here, never in `apps/web`. See Backend conventions below for the
  `src/` layout (`routes`, `services`, `jobs`, `lib`, `middleware`,
  `prompts`).
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
- Express middleware (e.g. auth) lives in `src/middleware`; AI prompt
  templates live in `src/prompts`.
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
