// Seeds (or removes) a confirmed test user plus a spread of analyses rows, so the
// auth-guarded screens can be screenshotted in their real states during the
// design pass. Follows smoke-test-profile-triggers.ts's conventions: the
// service-role client for everything, and it always cleans up after itself.
//
//   pnpm tsx scripts/seed-screenshot-user.ts
//   pnpm tsx scripts/seed-screenshot-user.ts --subscribed
//   pnpm tsx scripts/seed-screenshot-user.ts --quota-full
//   pnpm tsx scripts/seed-screenshot-user.ts --cleanup
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { createClient } from '@supabase/supabase-js';

const repoRoot = path.resolve(import.meta.dirname, '..');
const envLines = readFileSync(path.join(repoRoot, '.env'), 'utf8').split('\n');
const getEnv = (key: string) =>
  process.env[key] ?? envLines.find((l) => l.startsWith(key + '='))?.slice(key.length + 1).trim();

const SUPABASE_URL = getEnv('SUPABASE_URL');
const SERVICE_ROLE_KEY = getEnv('SUPABASE_SERVICE_ROLE_KEY');

const EMAIL = getEnv('SCREENSHOT_USER_EMAIL') ?? 'screenshots@chartanalyzer.dev';
const PASSWORD = getEnv('SCREENSHOT_USER_PASSWORD') ?? 'TestPassword123!';

if (!SUPABASE_URL || !SERVICE_ROLE_KEY) {
  throw new Error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY');
}

const cleanupOnly = process.argv.includes('--cleanup');
// Seeds usage at the plan limit so the quota-exhausted branch can be verified.
const quotaFull = process.argv.includes('--quota-full');
// Seeds the PAID state instead of the default Inactive one: the Billing screen
// is mostly hidden behind the paywall once the free tier grants nothing, so
// without this flag that screen screenshots as 0 / 0 with no cards worth
// looking at.
const subscribed = process.argv.includes('--subscribed');

/** Milliseconds in a billing month, for the seeded renewal date. */
const MONTH_MS = 30 * 24 * 60 * 60 * 1000;

/** The manual tier the subscribed seed puts the account on (30 analyses/month). */
const STARTER_PLAN_KEY = 'starter_monthly';
/** The add-on that gives the Billing screen its second meter. */
const DAILY_BRIEFING_PLAN_KEY = 'daily_briefing_monthly';
/** Figure the subscribed seed spends from that second meter — see below for why
 *  it is not zero. */
const BRIEFING_SEED_USED = 3;

const MODEL = { model_id: 'gpt-4o-mini', prompt_version: 'v4' };
const ago = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();

async function main() {
  const admin = createClient(SUPABASE_URL as string, SERVICE_ROLE_KEY as string, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  // Always start clean: deleting the auth user cascades to profiles, which
  // cascades to analyses and usage_counters.
  const { data: list } = await admin.auth.admin.listUsers();
  const existing = list?.users?.find((u) => u.email === EMAIL);
  if (existing) {
    await admin.auth.admin.deleteUser(existing.id);
    console.log('Removed previous screenshot user', existing.id);
  }

  if (cleanupOnly) {
    console.log('Cleanup complete.');
    return;
  }

  const { data: created, error: createErr } = await admin.auth.admin.createUser({
    email: EMAIL,
    password: PASSWORD,
    email_confirm: true,
  });
  if (createErr) throw createErr;
  const profile_id = created.user.id;
  console.log('Created screenshot user', profile_id);

  const rows = [
    {
      profile_id,
      source_type: 'paste',
      image_key: 'seed/reliance-15m.png',
      width_px: 1280,
      height_px: 720,
      symbol_raw: 'RELIANCE 15',
      symbol: 'RELIANCE',
      asset_class: 'stock',
      timeframe: 'm15',
      trend: 'bearish',
      volatility: 'high',
      volume_reading: 'low',
      sentiment: 'bearish',
      support_levels: [1402.4, 1388.15],
      resistance_levels: [1421.05, 1438.6],
      call_direction: 'short',
      call_confidence: 0.62,
      call_entry: 1402.4,
      call_invalidation: 1421.05,
      call_target: 1388.15,
      horizon_candles: 12,
      summary:
        'Price pushed to 1,438.60 and sold off through the session, and is now sitting just above the 1,402.40 shelf that has held twice on this timeframe. Volume has thinned on each of the last three pushes while the range per candle has widened, which reads as distribution rather than accumulation. A close below the shelf opens the 1,388.15 area; holding it keeps the 1,421.05 retest in play.',
      ...MODEL,
      input_tokens: 1842,
      output_tokens: 613,
      cost_usd: 0.0041,
      latency_ms: 6400,
      status: 'complete',
      created_at: ago(14),
    },
    {
      profile_id,
      source_type: 'upload',
      image_key: 'seed/nifty-1h.png',
      width_px: 1600,
      height_px: 900,
      symbol_raw: 'NIFTY 50 1H',
      symbol: 'NIFTY50',
      asset_class: 'index',
      timeframe: 'h1',
      trend: 'bullish',
      volatility: 'medium',
      volume_reading: 'high',
      sentiment: 'bullish',
      support_levels: [24810.0, 24655.5],
      resistance_levels: [25120.75],
      call_direction: 'long',
      call_confidence: 0.71,
      call_entry: 24880.0,
      call_invalidation: 24655.5,
      call_target: 25120.75,
      horizon_candles: 18,
      summary:
        'A clean higher-low sequence off 24,655.50 with expanding volume into each push. The 25,120.75 band is the only overhead supply visible on this timeframe.',
      ...MODEL,
      input_tokens: 1710,
      output_tokens: 540,
      cost_usd: 0.0037,
      latency_ms: 5200,
      status: 'complete',
      created_at: ago(120),
    },
    {
      profile_id,
      source_type: 'paste',
      image_key: 'seed/btc-4h.png',
      width_px: 1440,
      height_px: 810,
      symbol_raw: 'BTCUSDT 4H',
      symbol: 'BTCUSDT',
      asset_class: 'crypto',
      timeframe: 'h4',
      trend: 'neutral',
      volatility: 'low',
      volume_reading: 'medium',
      sentiment: 'neutral',
      support_levels: [61200.0],
      resistance_levels: [64400.0],
      call_direction: 'hold',
      call_confidence: 0.44,
      summary:
        'Range-bound between 61,200 and 64,400 with compressing candle bodies. No directional edge visible in this window.',
      ...MODEL,
      input_tokens: 1520,
      output_tokens: 410,
      cost_usd: 0.0031,
      latency_ms: 4800,
      status: 'complete',
      created_at: ago(540),
    },
    {
      profile_id,
      source_type: 'upload',
      image_key: 'seed/blurry.png',
      width_px: 640,
      height_px: 360,
      ...MODEL,
      input_tokens: 900,
      output_tokens: 0,
      cost_usd: 0.0008,
      latency_ms: 3100,
      status: 'failed',
      error_code: 'unreadable_chart',
      error_message: 'Candle bodies could not be resolved at this resolution.',
      created_at: ago(1440),
    },
    {
      profile_id,
      source_type: 'paste',
      image_key: 'seed/in-flight.png',
      width_px: 1280,
      height_px: 720,
      ...MODEL,
      status: 'processing',
      created_at: ago(2),
    },
  ];

  const { error: insertErr } = await admin.from('analyses').insert(rows);
  if (insertErr) throw insertErr;

  const period = new Date().toISOString().slice(0, 7);

  // Figures chosen to exercise the whole Billing screen rather than to depict a
  // realistic user: 12 of 30 spent leaves both a readable remainder AND a meter
  // with a visible fill, and 4 credits puts a non-zero balance next to the
  // allowance it is deliberately kept out of. A zeroed counter renders an empty
  // progress track, which verifies nothing. Overwritten below when not
  // subscribing, where the limit is the free plan's.
  let used = 12;

  if (subscribed) {
    const { data: plans, error: planErr } = await admin
      .from('plans')
      .select('id, key')
      .in('key', [STARTER_PLAN_KEY, DAILY_BRIEFING_PLAN_KEY])
      .returns<{ id: string; key: string }[]>();
    if (planErr) throw planErr;

    const starter = plans?.find((p) => p.key === STARTER_PLAN_KEY);
    const briefing = plans?.find((p) => p.key === DAILY_BRIEFING_PLAN_KEY);
    if (!starter || !briefing) {
      throw new Error(`Missing seed plans: ${STARTER_PLAN_KEY} / ${DAILY_BRIEFING_PLAN_KEY}`);
    }

    const now = Date.now();
    const periodEnd = new Date(now + MONTH_MS).toISOString();
    // Service role, because pricing_region and its neighbours are guarded by
    // Trigger C against every other writer — including the postgres role the
    // migrations themselves run as. It is exactly what the backend does the
    // first time it resolves an authenticated request's region.
    const { error: profileErr } = await admin
      .from('profiles')
      .update({
        plan_id: starter.id,
        credit_balance: 4,
        daily_briefing_credit_balance: 0,
        // 'geoip' is the source pricing-region.service.ts writes when it locks a
        // region, and the lock timestamp is how the screen knows the band is
        // settled rather than still being derived.
        pricing_region: 'IN',
        pricing_region_source: 'geoip',
        pricing_region_locked_at: new Date(now).toISOString(),
        detected_country_code: 'IN',
      })
      .eq('id', profile_id);
    if (profileErr) throw profileErr;

    // A live add-on row is the only thing that makes the briefing meter appear:
    // fetchPlanSummary() shows it only for an add-on key present in the live
    // subscription set. amount_minor is paise — the ₹299 price, as an integer.
    const { error: subErr } = await admin.from('subscriptions').insert({
      profile_id,
      plan_id: briefing.id,
      provider_subscription_id: `sub_seed_${profile_id.slice(0, 8)}_${now}`,
      status: 'active',
      current_period_start: new Date(now - 2 * 24 * 60 * 60 * 1000).toISOString(),
      current_period_end: periodEnd,
      charge_at: periodEnd,
      amount_minor: 29900,
      currency: 'INR',
    });
    if (subErr) throw subErr;

    const { error: briefingErr } = await admin
      .from('daily_briefing_usage_counters')
      .upsert(
        { profile_id, period, analyses_used: BRIEFING_SEED_USED },
        { onConflict: 'profile_id,period' },
      );
    if (briefingErr) throw briefingErr;

    console.log(`Subscribed seed: ${STARTER_PLAN_KEY} + ${DAILY_BRIEFING_PLAN_KEY}, region IN`);
  } else {
    const { data: profile } = await admin
      .from('profiles')
      .select('plans(analyses_per_month)')
      .eq('id', profile_id)
      .single<{ plans: { analyses_per_month: number } }>();
    const limit = profile?.plans?.analyses_per_month ?? 3;
    // One short of the limit, so the default seed leaves an analysis unspent and
    // the out-of-quota branch stays opt-in via --quota-full.
    used = quotaFull ? limit : Math.max(0, limit - 1);
  }

  const { error: usageErr } = await admin
    .from('usage_counters')
    .upsert({ profile_id, period, analyses_used: used }, { onConflict: 'profile_id,period' });
  if (usageErr) throw usageErr;

  console.log(`Seeded ${rows.length} analyses and usage for ${period}.`);
  console.log(`Sign in as ${EMAIL} / ${PASSWORD}`);
}

main().catch((cause) => {
  console.error(cause);
  process.exit(1);
});
