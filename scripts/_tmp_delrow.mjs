// Temporary: removes one test row inserted during a layout-diagnosis session.
// Safe to delete this file after running. Run from repo root: node scripts/_tmp_delrow.mjs
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { createClient } from '@supabase/supabase-js';

const envLines = readFileSync(path.resolve(import.meta.dirname, '../.env'), 'utf8').split('\n');
const getEnv = (k) =>
  process.env[k] ?? envLines.find((l) => l.startsWith(k + '='))?.slice(k.length + 1).trim();

const admin = createClient(getEnv('SUPABASE_URL'), getEnv('SUPABASE_SERVICE_ROLE_KEY'), {
  auth: { autoRefreshToken: false, persistSession: false },
});

const { error } = await admin
  .from('analyses')
  .delete()
  .eq('id', '3420a23f-ee3c-4da2-a32c-3cf2bb6da1f7');
console.log(error ? error.message : 'deleted temp row 3420a23f');
