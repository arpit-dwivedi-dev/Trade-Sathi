/**
 * Generates a seed migration for the disposable-email blocklist from the
 * `disposable-email-domains` package.
 *
 * Usage:
 *   pnpm gen:disposable-domains <timestamp>
 *
 * Note the lack of `--`: `pnpm run <script> -- <arg>` swallows the separator
 * and the script receives no timestamp.
 *
 * Pick <timestamp> per CLAUDE.md: run `npx supabase migration list` and choose
 * a value later than the newest entry shown. Do not use this machine's clock —
 * it has been found out of sync with the migration sequence.
 *
 * Each run writes a NEW migration file and refuses to overwrite an existing
 * one. Regenerating in place would leave an already-applied migration whose
 * content no longer matches what the database ran, which is how the blocklist
 * migrations drifted the first time.
 *
 * The emitted SQL is authoritative, not additive: it truncates both tables and
 * refills them from the package. That matters because domains get *removed*
 * upstream when they stop being disposable — an insert-only seed would keep
 * blocking them forever.
 */
import { createRequire } from 'node:module';
import { existsSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const require = createRequire(import.meta.url);
const domains = require('disposable-email-domains');
const wildcards = require('disposable-email-domains/wildcard.json');
const { version } = require('disposable-email-domains/package.json');

const timestamp = process.argv[2];

if (!/^\d{14}$/.test(timestamp ?? '')) {
  console.error(
    'Usage: pnpm gen:disposable-domains <timestamp>\n\n' +
      'Where <timestamp> is 14 digits (YYYYMMDDHHMMSS), later than the newest\n' +
      'entry from `npx supabase migration list`.\n\n' +
      'Do not write `pnpm run gen:disposable-domains -- <timestamp>`: pnpm\n' +
      'swallows the `--` and this script receives no argument.',
  );
  process.exit(1);
}

/** Postgres single-quoted literal. Domains are ASCII, but be strict anyway. */
const lit = (value) => `'${String(value).toLowerCase().replace(/'/g, "''")}'`;

const normalize = (values) =>
  [...new Set(values.map((v) => String(v).trim().toLowerCase()).filter(Boolean))].sort();

const domainList = normalize(domains);
const wildcardList = normalize(wildcards);

/** Chunked so no single INSERT statement gets absurdly large. */
function insertStatements(table, column, values, chunkSize = 1000) {
  const out = [];
  for (let i = 0; i < values.length; i += chunkSize) {
    const rows = values.slice(i, i + chunkSize).map(lit).join(', ');
    out.push(
      `insert into public.${table} (${column})\nselect unnest(array[${rows}])\non conflict do nothing;`,
    );
  }
  return out.join('\n\n');
}

const sql = `-- GENERATED FILE — DO NOT EDIT BY HAND.
-- Regenerate with: pnpm gen:disposable-domains <new timestamp>
--
-- Source: disposable-email-domains@${version}
-- Exact domains: ${domainList.length}
-- Wildcard suffixes: ${wildcardList.length}
--
-- Replaces the contents of the blocklist tables created in
-- 20260831120000_disposable_email_signup_block.sql. This is a full resync, not
-- an append: domains dropped upstream (no longer disposable) must stop being
-- blocked, so the tables are truncated first. Both statements run in the
-- migration's transaction, so readers never observe an empty blocklist.

truncate public.disposable_email_domains;
truncate public.disposable_email_wildcards;

${insertStatements('disposable_email_domains', 'domain', domainList)}

${insertStatements('disposable_email_wildcards', 'suffix', wildcardList)}

analyze public.disposable_email_domains;
analyze public.disposable_email_wildcards;
`;

const outPath = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  'supabase',
  'migrations',
  `${timestamp}_seed_disposable_email_domains.sql`,
);

if (existsSync(outPath)) {
  console.error(
    `Refusing to overwrite ${outPath}\n` +
      'That migration may already have been applied. Choose a new timestamp.',
  );
  process.exit(1);
}

writeFileSync(outPath, sql);

console.log(
  `Wrote ${outPath}\n  ${domainList.length} domains, ${wildcardList.length} wildcards (disposable-email-domains@${version})`,
);
