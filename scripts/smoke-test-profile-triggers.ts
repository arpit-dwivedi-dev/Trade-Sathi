// Verifies the profiles/auth.users Postgres triggers: profile-on-signup creation,
// email_verified sync on confirmation, and the RLS block on direct plan_id updates
// by an authenticated (non-service-role) user. Safe to re-run after any future
// migration touching these triggers — it creates and always cleans up its own test user.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { Client } from 'pg';
import { createClient } from '@supabase/supabase-js';

const repoRoot = path.resolve(import.meta.dirname, '..');
const envPath = path.join(repoRoot, '.env');
const envLines = readFileSync(envPath, 'utf8').split('\n');
const getEnv = (key: string) =>
  process.env[key] ?? envLines.find((l) => l.startsWith(key + '='))?.slice(key.length + 1).trim();

const DB_URL = getEnv('SUPABASE_DB_URL');
const SUPABASE_URL = getEnv('SUPABASE_URL');
const SERVICE_ROLE_KEY = getEnv('SUPABASE_SERVICE_ROLE_KEY');
const TEST_EMAIL = getEnv('SMOKE_TEST_USER_EMAIL') ?? 'test@chartanalyzer.dev';
const TEST_PASSWORD = getEnv('SMOKE_TEST_USER_PASSWORD') ?? 'TestPassword123!';

if (!DB_URL || !SUPABASE_URL || !SERVICE_ROLE_KEY) {
  throw new Error('Missing SUPABASE_DB_URL, SUPABASE_URL, or SUPABASE_SERVICE_ROLE_KEY in environment');
}

async function main() {
  const admin = createClient(SUPABASE_URL as string, SERVICE_ROLE_KEY as string, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const client = new Client({ connectionString: DB_URL });
  await client.connect();
  const report: Record<string, string> = {};
  let userId: string | undefined;

  try {
    // cleanup any prior run
    const { data: existingList } = await admin.auth.admin.listUsers();
    const existing = existingList?.users?.find((u) => u.email === TEST_EMAIL);
    if (existing) await admin.auth.admin.deleteUser(existing.id);

    // 1. Create test user via Supabase Auth admin API (email unconfirmed)
    const { data: created, error: createErr } = await admin.auth.admin.createUser({
      email: TEST_EMAIL,
      password: TEST_PASSWORD,
      email_confirm: false,
    });
    if (createErr) throw createErr;
    userId = created.user.id;
    console.log('Created test user', userId);

    // 2. Check Trigger A
    const profileRes1 = await client.query(
      `select id, email, email_verified, plan_id from public.profiles where id = $1`,
      [userId],
    );
    const freePlanRes = await client.query(`select id from public.plans where key = 'free'`);
    const freePlanId = freePlanRes.rows[0]?.id;
    if (profileRes1.rows.length === 1) {
      const p = profileRes1.rows[0];
      report.triggerA =
        p.email === TEST_EMAIL && p.email_verified === false && p.plan_id === freePlanId
          ? 'PASS'
          : `FAIL (row=${JSON.stringify(p)}, expectedFreePlan=${freePlanId})`;
    } else {
      report.triggerA = `FAIL (no profile row found, count=${profileRes1.rows.length})`;
    }

    // 3. Confirm email -> Trigger B (via Supabase Auth admin API)
    const { error: confirmErr } = await admin.auth.admin.updateUserById(userId, { email_confirm: true });
    if (confirmErr) throw confirmErr;
    const profileRes2 = await client.query(`select email_verified from public.profiles where id = $1`, [userId]);
    report.triggerB =
      profileRes2.rows[0]?.email_verified === true
        ? 'PASS'
        : `FAIL (email_verified=${profileRes2.rows[0]?.email_verified})`;

    // 4. Trigger C: attempt direct plan_id update as authenticated (non-service) role
    const proPlanRes = await client.query(`select id from public.plans where key = 'pro_monthly'`);
    const proPlanId = proPlanRes.rows[0]?.id;

    await client.query('begin');
    try {
      await client.query(`set local role authenticated`);
      await client.query(`set local request.jwt.claims = '${JSON.stringify({ sub: userId, role: 'authenticated' })}'`);
      await client.query(`update public.profiles set plan_id = $1 where id = $2`, [proPlanId, userId]);
      report.triggerC = 'FAIL (update succeeded, protection is broken - no exception raised)';
      await client.query('commit');
    } catch (err) {
      report.triggerC = `PASS (blocked with: ${(err as Error).message})`;
      await client.query('rollback');
    }
    await client.query(`reset role`);
  } finally {
    // cleanup
    if (userId) {
      try {
        await admin.auth.admin.deleteUser(userId);
      } catch (e) {
        // best-effort cleanup
      }
    }
    await client.end();
  }

  console.log('\n--- REPORT ---');
  console.log(`Trigger A (profile creation on signup): ${report.triggerA}`);
  console.log(`Trigger B (email_verified sync): ${report.triggerB}`);
  console.log(`Trigger C (block direct plan_id update): ${report.triggerC}`);
}

main().catch((e) => {
  console.error('SCRIPT ERROR:', e);
  process.exit(1);
});
