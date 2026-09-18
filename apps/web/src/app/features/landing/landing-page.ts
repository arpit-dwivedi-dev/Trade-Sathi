import { DOCUMENT } from '@angular/common';
import { HttpClient } from '@angular/common/http';
import {
  Component,
  DestroyRef,
  ElementRef,
  OnInit,
  Renderer2,
  afterNextRender,
  computed,
  inject,
  signal,
} from '@angular/core';
import { Router, RouterLink } from '@angular/router';
import { firstValueFrom } from 'rxjs';

import type { PricingOverview } from '@tradesathi/shared';

import { SupabaseClientService } from '../../core/supabase-client';
import { ThemeService } from '../../core/theme.service';
import { formatPriceMinor } from '../billing/billing.service';

interface FaqEntry {
  question: string;
  answer: string;
}

/** One list for the visible FAQ and the FAQPage JSON-LD, so they cannot drift. */
const FAQS: readonly FaqEntry[] = [
  {
    question: 'What do I actually get back?',
    answer:
      'A structured read of the chart you uploaded: the trend state with a clarity rating, support and resistance zones with touch counts and distance in ATR units, the volatility regime, one or two scenarios each with a trigger band, an invalidation level, a target and the probability the target is touched first, a falsifier, and a base rate from analogous historical setups.',
  },
  {
    question: 'Does it tell me when it cannot read a chart?',
    answer:
      'Yes. If the screenshot is cropped, the axis is unreadable or there are too few candles to form a view, the output says so instead of inventing levels, and the credit is refunded automatically.',
  },
  {
    question: 'Is this investment advice?',
    answer:
      'No. Trade Sathi produces analysis output. It is not a registered investment adviser, it does not know your position size or risk tolerance, and it never tells you to buy or sell. Every decision and every consequence stays yours.',
  },
  {
    question: 'Why credits instead of a subscription?',
    answer:
      'Because reading charts is not a daily habit for most traders. A subscription would charge you in the weeks you do not trade. Credits sit in your balance until you use them, and there is nothing to cancel.',
  },
  {
    question: 'Which charts and timeframes work?',
    answer:
      'Candlestick, OHLC bar, line, Heikin Ashi and Renko charts, on timeframes from m1 to w1, across equities, indices, futures, options, crypto, FX and commodities. Screenshots from any charting platform are fine.',
  },
  {
    question: 'What happens if an analysis fails?',
    answer:
      'The credit is returned to your balance without you asking, and the failure is recorded in History with the reason. You can retry with a wider screenshot or a different timeframe at no extra cost.',
  },
];

const TAGLINE =
  'Every read states its own clarity, and the one condition that would break it.'.split(' ');

/** Illustrative only — labelled as such on the page. Doubled so the loop has no seam. */
const TAPE_ROWS: readonly [string, string, string][] = [
  ['RELIANCE', '₹1,478.40', '+0.42%'],
  ['HDFCBANK', '₹1,694.25', '-0.18%'],
  ['TATAMOTORS', '₹742.85', '+1.06%'],
  ['INFY', '₹1,556.70', '-0.64%'],
  ['NIFTY 50', '24,318.45', '+0.27%'],
  ['BANKNIFTY', '52,214.80', '+0.39%'],
  ['SBIN', '₹618.35', '-0.22%'],
  ['ICICIBANK', '₹1,142.90', '+0.55%'],
  ['ITC', '₹436.15', '+0.11%'],
  ['USDINR', '87.42', '-0.09%'],
];

/* ── live hero chart ───────────────────────────────────────────────────── */

const LIVE = { n: 56, w: 1440, top: 140, bot: 620, volTop: 700, volBot: 830, bw: 9 };
const STEP = LIVE.w / (LIVE.n - 1);
/**
 * Pricing backdrop: a periodic price-like line (whole-cycle sines, so the end
 * meets the start) drawn twice across 2×width, then panned by CSS forever.
 */
const PRICING_LINE = (() => {
  const pts: string[] = [];
  for (let x = 0; x <= LIVE.w * 2; x += 12) {
    const t = (x / LIVE.w) * Math.PI * 2;
    const y =
      400 +
      Math.sin(t * 2) * 90 +
      Math.sin(t * 5 + 1.3) * 45 +
      Math.sin(t * 11 + 0.7) * 22 +
      Math.sin(t * 23 + 2.1) * 10;
    pts.push(`${x},${y.toFixed(1)}`);
  }
  return pts.join(' ');
})();

const PHASES = ['Reading the series', 'Zones located', 'Scenario drafted', 'Holding the read'];

interface Candle {
  x: number;
  bx: number;
  high: number;
  low: number;
  by: number;
  bh: number;
  vy: number;
  vh: number;
  color: string;
  fade: number;
}

/** Seeded so the server-rendered first frame and the hydrated one agree. */
function seeded(seed: number): () => number {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function seedSeries(): number[] {
  const rand = seeded(1478);
  const out: number[] = [];
  let p = 1478.4;
  for (let i = 0; i < LIVE.n; i++) {
    p += Math.sin(i * 0.7) * 3.2 + (rand() - 0.48) * 6;
    out.push(+p.toFixed(2));
  }
  return out;
}

/**
 * Public marketing page — the only route reachable without a session.
 *
 * Pricing is the one live-data section: GET /api/pricing gives the caller's
 * real region rate, top-ups and feature costs. Browser-only, since a relative
 * /api URL has nothing to resolve against during SSR — the server render shows
 * the skeleton and hydration fills it in.
 */
@Component({
  selector: 'app-landing-page',
  imports: [RouterLink],
  styleUrl: './landing-page.css',
  templateUrl: './landing-page.html',
})
export class LandingPage implements OnInit {
  private readonly themeService = inject(ThemeService);
  private readonly http = inject(HttpClient);
  private readonly supabase = inject(SupabaseClientService);
  private readonly document = inject(DOCUMENT);
  private readonly renderer = inject(Renderer2);
  private readonly router = inject(Router);
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);
  private readonly destroyRef = inject(DestroyRef);

  protected readonly theme = this.themeService.theme;
  protected readonly faqs = FAQS;
  protected readonly tagline = TAGLINE;
  protected readonly tape = [...TAPE_ROWS, ...TAPE_ROWS].map(([symbol, price, change]) => ({
    symbol,
    price,
    change,
    up: !change.startsWith('-'),
  }));

  protected readonly pricing = signal<PricingOverview | null>(null);
  protected readonly menuOpen = signal(false);
  protected readonly navLifted = signal(false);
  protected readonly activeSection = signal<string | null>(null);
  protected readonly openFaq = signal<number | null>(null);
  protected readonly formMessage = signal('');

  /* live chart state */
  private readonly series = signal<number[]>(seedSeries());
  private readonly tick = signal(0);
  private readonly open = this.series()[LIVE.n - 2];

  protected readonly pricingLine = PRICING_LINE;
  protected readonly live = computed(() => this.geometry(this.series(), this.tick()));

  protected readonly credits = computed(() => {
    const p = this.pricing();
    if (!p) return null;
    const { currency, pricePerCreditMinor, minPurchaseCredits, quickAmountsMinor, region } =
      p.pricing;
    return {
      region,
      rate: formatPriceMinor(pricePerCreditMinor, currency),
      minimum: minPurchaseCredits,
      topups: quickAmountsMinor.map((amount) => ({
        price: formatPriceMinor(amount, currency),
        credits: Math.floor(amount / pricePerCreditMinor),
      })),
    };
  });

  private schemaScript: HTMLScriptElement | null = null;

  constructor() {
    afterNextRender(() => this.startBrowserEffects());
    this.destroyRef.onDestroy(() => {
      if (this.schemaScript) this.renderer.removeChild(this.document.head, this.schemaScript);
      this.document.body.style.overflow = '';
    });
  }

  ngOnInit(): void {
    // Server-rendered too: crawlers that skip JS still see the FAQ schema.
    const schema = {
      '@context': 'https://schema.org',
      '@type': 'FAQPage',
      mainEntity: this.faqs.map((f) => ({
        '@type': 'Question',
        name: f.question,
        acceptedAnswer: { '@type': 'Answer', text: f.answer },
      })),
    };
    const script = this.renderer.createElement('script') as HTMLScriptElement;
    this.renderer.setAttribute(script, 'type', 'application/ld+json');
    this.renderer.setProperty(script, 'text', JSON.stringify(schema));
    this.renderer.appendChild(this.document.head, script);
    this.schemaScript = script;

    if (!this.supabase.isBrowser) return;
    firstValueFrom(this.http.get<PricingOverview>('/api/pricing'))
      .then((overview) => this.pricing.set(overview))
      .catch(() => undefined);
  }

  protected toggleTheme(): void {
    this.themeService.toggle();
  }

  protected setMenu(open: boolean): void {
    this.menuOpen.set(open);
    this.document.body.style.overflow = open ? 'hidden' : '';
  }

  protected toggleFaq(index: number, panel: HTMLElement): void {
    const closing = this.openFaq() === index;
    // Collapse whichever was open, measured from its current height.
    const root = this.host.nativeElement;
    root.querySelectorAll<HTMLElement>('.ts-faq-a-wrap').forEach((el) => {
      if (el === panel && !closing) return;
      el.style.height = `${el.scrollHeight}px`;
      requestAnimationFrame(() => {
        el.style.height = '0px';
        el.style.opacity = '0';
      });
    });
    if (closing) {
      this.openFaq.set(null);
      return;
    }
    this.openFaq.set(index);
    panel.style.height = `${panel.scrollHeight}px`;
    panel.style.opacity = '1';
  }

  protected onSubmit(event: Event, email: string): void {
    event.preventDefault();
    const value = email.trim();
    if (!value) {
      this.formMessage.set('Enter your email address to continue.');
      return;
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(value)) {
      this.formMessage.set(
        'That does not look like an email address. Check for a missing @ or domain.',
      );
      return;
    }
    this.formMessage.set('');
    void this.router.navigate(['/signup']);
  }

  /* ── geometry ────────────────────────────────────────────────────────── */

  private geometry(s: number[], tick: number) {
    const lo = Math.min(...s);
    const hi = Math.max(...s);
    const pad = Math.max(6, (hi - lo) * 0.22);
    const top = lo - pad;
    const span = hi + pad - top;
    const y = (v: number) => +(LIVE.bot - ((v - top) / span) * (LIVE.bot - LIVE.top)).toFixed(1);
    const step = tick % 20;
    const phase = step < 4 ? 0 : step < 9 ? 1 : step < 17 ? 2 : 3;
    const lineMode = Math.floor(tick / 20) % 2 === 1;

    const candles: Candle[] = s.map((c, i) => {
      const o = i === 0 ? c : s[i - 1];
      const jitter = 1.6 + ((Math.sin(i * 7.3 + tick) + 1) / 2) * 3.4;
      const bodyTop = y(Math.max(o, c));
      const vol = 0.36 + Math.min(1, Math.abs(c - o) / 7) * 0.5;
      const vh = +((LIVE.volBot - LIVE.volTop) * vol).toFixed(1);
      const x = +(i * STEP).toFixed(1);
      return {
        x,
        bx: +(x - LIVE.bw / 2).toFixed(1),
        high: y(Math.max(o, c) + jitter),
        low: y(Math.min(o, c) - jitter),
        by: bodyTop,
        bh: +Math.max(1.4, y(Math.min(o, c)) - bodyTop).toFixed(1),
        vy: +(LIVE.volBot - vh).toFixed(1),
        vh,
        color: c >= o ? '#089981' : '#F23645',
        fade: i === s.length - 1 ? 0.35 : 1,
      };
    });

    const recent = s.slice(-28);
    const rHi = Math.max(...recent);
    const rLo = Math.min(...recent);
    const price = s[s.length - 1];
    const changePct = ((price - this.open) / this.open) * 100;
    const priceY = y(price);
    const lastX = +((LIVE.n - 1) * STEP).toFixed(1);

    return {
      candles,
      grid: [0.15, 0.35, 0.55, 0.75, 0.95].map((f) => +(LIVE.top + f * (LIVE.bot - LIVE.top)).toFixed(1)),
      candleOpacity: lineMode ? 0 : 1,
      lineOpacity: lineMode ? 1 : 0,
      linePoints: s.map((c, i) => `${(i * STEP).toFixed(1)},${y(c)}`).join(' '),
      res: { y: y(rHi + 3), h: +(y(rHi - 5) - y(rHi + 3)).toFixed(1) },
      sup: { y: y(rLo + 5), h: +(y(rLo - 3) - y(rLo + 5)).toFixed(1) },
      zoneOpacity: phase >= 1 ? 1 : 0,
      projOpacity: phase >= 2 ? 1 : 0,
      projection: `M${lastX} ${priceY} L${lastX - 90} ${y(price + 9)} L${lastX - 170} ${y(rHi + 2)}`,
      priceY,
      lastX,
      scanX: phase === 0 ? +(((tick % 4) / 3) * LIVE.w).toFixed(0) : 0,
      scanOpacity: phase === 0 ? 0.55 : 0,
      priceLabel:
        '₹' + price.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 }),
      changeLabel: (changePct >= 0 ? '+' : '') + changePct.toFixed(2) + '%',
      changeUp: changePct >= 0,
      phaseLabel: PHASES[phase],
    };
  }

  /* ── browser-only effects ────────────────────────────────────────────── */

  private startBrowserEffects(): void {
    const root = this.host.nativeElement;
    const win = this.document.defaultView;
    if (!win) return;
    const reduced = win.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const observers: IntersectionObserver[] = [];

    // If IntersectionObserver never fires (some embedded renderers), show everything.
    let fired = false;
    const fallback = win.setTimeout(() => {
      if (!fired) root.classList.add('ts-revealed');
    }, 400);

    const reveal = new IntersectionObserver(
      (entries) =>
        entries.forEach((e) => {
          if (!e.isIntersecting) return;
          fired = true;
          e.target.classList.add('is-in');
          reveal.unobserve(e.target);
        }),
      { threshold: 0.15, rootMargin: '0px 0px -8% 0px' },
    );
    root.querySelectorAll('.ts-reveal').forEach((n) => reveal.observe(n));
    observers.push(reveal);

    const words = Array.from(root.querySelectorAll<HTMLElement>('.ts-word'));
    words.forEach((w, i) => (w.style.transitionDelay = `${i * 45}ms`));
    const wordObs = new IntersectionObserver(
      (entries) =>
        entries.forEach((e) => {
          if (!e.isIntersecting) return;
          fired = true;
          e.target.classList.add('is-in');
          wordObs.unobserve(e.target);
        }),
      { threshold: 1, rootMargin: '0px 0px -45% 0px' },
    );
    words.forEach((w) => wordObs.observe(w));
    observers.push(wordObs);

    const sentinel = root.querySelector('.ts-sentinel');
    if (sentinel) {
      const navObs = new IntersectionObserver((entries) => {
        const atTop = entries[0].isIntersecting;
        this.navLifted.set(!atTop);
        if (atTop) this.activeSection.set(null);
      });
      navObs.observe(sentinel);
      observers.push(navObs);
    }

    const linkObs = new IntersectionObserver(
      (entries) =>
        entries.forEach((e) => {
          if (e.isIntersecting) this.activeSection.set(e.target.id);
        }),
      { threshold: 0.35, rootMargin: '-96px 0px -40% 0px' },
    );
    ['the-read', 'how', 'pricing', 'faq'].forEach((id) => {
      const s = root.querySelector('#' + id);
      if (s) linkObs.observe(s);
    });
    observers.push(linkObs);

    // Probabilities count up so they read as computed, not printed.
    const countObs = new IntersectionObserver(
      (entries) =>
        entries.forEach((e) => {
          if (!e.isIntersecting) return;
          const n = e.target as HTMLElement;
          const target = parseFloat(n.dataset['count'] ?? '0');
          const t0 = performance.now();
          const frame = (now: number) => {
            const p = Math.min(1, (now - t0) / 900);
            n.textContent = (target * (1 - Math.pow(1 - p, 3))).toFixed(1) + '%';
            if (p < 1) requestAnimationFrame(frame);
          };
          if (!reduced) requestAnimationFrame(frame);
          countObs.unobserve(n);
        }),
      { threshold: 1 },
    );
    root.querySelectorAll('[data-count]').forEach((n) => countObs.observe(n));
    observers.push(countObs);

    const onResize = () => {
      if (win.innerWidth >= 860 && this.menuOpen()) this.setMenu(false);
    };
    win.addEventListener('resize', onResize);

    let timer: number | undefined;
    if (!reduced) {
      const rand = Math.random;
      timer = win.setInterval(() => {
        const s = this.series().slice();
        const last = s[s.length - 1];
        s.push(+(last + (1478 - last) * 0.03 + (rand() - 0.5) * 7.4).toFixed(2));
        s.shift();
        this.series.set(s);
        this.tick.update((t) => t + 1);
        this.glide(root);
      }, 900);
    }

    this.destroyRef.onDestroy(() => {
      win.clearTimeout(fallback);
      if (timer !== undefined) win.clearInterval(timer);
      win.removeEventListener('resize', onResize);
      observers.forEach((o) => o.disconnect());
    });
  }

  /** New candle is drawn one slot right, then the series glides left one tick. */
  private glide(root: HTMLElement): void {
    const groups = root.querySelectorAll<SVGGElement>('.ts-treadmill');
    if (!groups.length) return;
    groups.forEach((g) => {
      g.style.transition = 'none';
      g.style.transform = `translateX(${STEP.toFixed(2)}px)`;
    });
    void root.getBoundingClientRect();
    requestAnimationFrame(() => {
      groups.forEach((g) => {
        g.style.transition = 'transform 900ms linear';
        g.style.transform = 'translateX(0)';
      });
    });
  }
}
