// Seeds (or removes) a confirmed test user plus a spread of analyses rows, so the
// auth-guarded screens can be screenshotted in their real states during the
// design pass. Follows smoke-test-profile-triggers.ts's conventions: the
// service-role client for everything, and it always cleans up after itself.
//
//   pnpm tsx scripts/seed-screenshot-user.ts
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
  const { data: profile } = await admin
    .from('profiles')
    .select('plans(analyses_per_month)')
    .eq('id', profile_id)
    .single<{ plans: { analyses_per_month: number } }>();
  const limit = profile?.plans?.analyses_per_month ?? 3;

  const { error: usageErr } = await admin
    .from('usage_counters')
    .upsert(
      { profile_id, period, analyses_used: quotaFull ? limit : Math.max(0, limit - 1) },
      { onConflict: 'profile_id,period' },
    );
  if (usageErr) throw usageErr;

  console.log(`Seeded ${rows.length} analyses and usage for ${period}.`);
  console.log(`Sign in as ${EMAIL} / ${PASSWORD}`);
}

main().catch((cause) => {
  console.error(cause);
  process.exit(1);
});
