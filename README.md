# ChartAnalyzer

Analyzes trading chart screenshots using AI and returns pattern
detection, support/resistance levels, and a directional call.

## Structure

- `apps/web` — Angular 22 (standalone, SSR) frontend.
- `apps/api` — Node.js + TypeScript + Express backend.
- `packages/shared` — shared TypeScript types.
- `supabase/` — Supabase Cloud project config and migrations.

## Development

```
pnpm install
pnpm dev:web   # Angular dev server
pnpm dev:api   # Express API with reload
pnpm dev       # both, concurrently
```

See `CLAUDE.md` for conventions.
