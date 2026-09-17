# Trade Sathi — brand assets

Vector source of truth for the mark, lockups, and derived raster exports.
Mark geometry is hand-built SVG path data (no raster trace), drawn on a
240 × 300 grid; every export below is generated from those same paths.

## Palette

| Token | Hex | Role |
|---|---|---|
| `--ts-color-primary` | `#0B1220` | navy — trust, precision, focus |
| `--ts-color-accent-bullish` | `#00D4A0` | growth, opportunity, upside |
| `--ts-color-accent-bearish` | `#FF5C5C` | warning, caution, downside |
| `--ts-color-background` | `#F5F7FA` | clean, modern, minimal |

## Contents

```
brand/
├─ svg/
│  ├─ logo-mark.svg                      icon, full colour (240 × 300)
│  ├─ logo-mark-mono-dark.svg            icon, navy only — light backgrounds
│  ├─ logo-mark-mono-light.svg           icon, #F5F7FA only — dark backgrounds
│  ├─ logo-lockup-horizontal.svg         icon + wordmark (625 × 120)
│  ├─ logo-lockup-horizontal-dark-bg.svg same, light chevron + light "Trade"
│  └─ logo-lockup-tagline.svg            icon + wordmark + tagline
├─ favicon/      favicon.svg · favicon.ico (16/32/48) · 16 · 32 · apple-touch-icon 180
├─ pwa-icons/    192 · 512 · maskable 192 · maskable 512
├─ social/       og-image 1200×630 · twitter-card 1200×675
├─ mobile-app/   ios 1024 · android adaptive foreground/background 512
├─ color-tokens/ brand-colors.css
└─ index-head.snippet.html               <head> tags to paste into index.html
```

## Typography

Wordmark: **Plus Jakarta Sans ExtraBold (800)**, tracking −0.02 em.
Tagline: **Plus Jakarta Sans SemiBold (600)**, tracking +0.16 em, all caps,
optically set to the exact width of the wordmark above it. Both are SIL OFL —
self-host the woff2 in production rather than hot-linking Google Fonts.

## Clearspace and minimum sizes

- Clearspace on all sides ≥ half the mark's width (48 units at the 240 × 300 grid).
- Mark alone: no smaller than 20 px tall on screen; below that use `favicon.svg`,
  which is drawn as a navy tile with a light chevron for small-size legibility.
- Lockup: no smaller than 120 px wide. Below that, drop to the mark.
- Never recolour the bars, restack the three elements, or add effects.
  On busy or photographic backgrounds use `logo-mark-mono-light.svg`.

## Wiring

1. Paste `index-head.snippet.html` into `apps/web/src/index.html` (`<head>`),
   then replace `https://YOUR-DOMAIN` in the two `og:image` / `twitter:image`
   URLs — link previews require absolute URLs.
2. `manifest.webmanifest` is written to `apps/web/public/manifest.webmanifest`
   and already points at `/brand/pwa-icons/*`.
3. Import `color-tokens/brand-colors.css` from `src/styles/` (or copy it there
   if you want it bundled rather than served), and reconcile the `--ts-` prefix
   with your existing `src/styles/tokens.css`.

## Manual steps still outstanding

1. **Convert the lockup text to outlines.** The three files in `svg/` that
   contain "Trade Sathi" use live `<text>` in Plus Jakarta Sans (with a Google
   Fonts `@import` and a system fallback stack). They render correctly in a
   browser, but for print, PDF, Illustrator, or any offline consumer the text
   must be outlined once:
   `inkscape logo-lockup-tagline.svg --export-text-to-path --export-plain-svg=logo-lockup-tagline.svg`
   (or in Figma/Illustrator: select the text → Outline Stroke / Create Outlines).
   The mark files contain no text and need nothing.
2. **`favicon.ico` uses PNG-compressed entries** (16/32/48, 32-bit). Correct for
   every current browser and Windows Vista+. If you must support IE ≤ 9, re-emit
   with BMP entries: `magick favicon-16x16.png favicon-32x32.png favicon-48.png -colors 256 favicon.ico`.
3. **Play Store / App Store listing art** (1024 feature graphic, screenshots,
   splash screens) is out of scope — the mobile-app folder only covers the
   launcher icon layers. The iOS 1024 PNG is already flattened with no alpha
   channel, as the App Store requires.
