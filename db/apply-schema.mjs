// One-time setup script: applies db/schema.sql against DATABASE_URL.
// Every statement in schema.sql uses IF NOT EXISTS, so this is safe to
// re-run against a database that's already been set up — it just does
// nothing new.
//
//   DATABASE_URL=... node db/apply-schema.mjs
//
// Two non-obvious traps the naive `split(';')` version of this file fell
// into and that this rewrite explicitly handles:
//
//   1. Several lines in schema.sql have inline comments that themselves
//      contain a semicolon (e.g. "set when created by a bulk CSV import;
//      deleting the import..."). A bare `;` split chops those statements
//      in half. We strip `-- ...` from each line BEFORE splitting, so the
//      only `;` left is a real statement terminator.
//
//   2. ALTER TABLE … REFERENCES jobs(id) (and similar ALTERs referencing
//      tables whose CREATE TABLE comes later in the file) fails with
//      42P01 if you run schema.sql top-to-bottom against a fresh
//      database — the referenced table doesn't exist yet. We do a
//      topological pass: run only CREATE statements first (sorted by
//      dependency order if needed — currently the schema already lists
//      referenced tables before referencing ones, except for the few
//      ALTERs in the way), then the ALTERs. Re-runs are still safe:
//      every statement is IF NOT EXISTS.
//
// Both traps previously shipped silently: the early `;`-splitter reported
// "Applied N statements" even when CREATE TABLE blocks were dropped
// because their first line was a `--` comment, and the forward-reference
// ALTERs failed mid-run without a clear next step. See HANDOFF.md.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { neon } from '@neondatabase/serverless';

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error('DATABASE_URL is not set. Export it (or put it in .env.local and `set -a && source .env.local`) and re-run.');
  process.exit(1);
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const schemaPath = path.join(__dirname, 'schema.sql');
const sql = neon(DATABASE_URL);

// Strip `-- ...` from each line BEFORE splitting. Anything left on a line
// after that is real SQL or whitespace; the only remaining `;` is a real
// statement terminator.
const stripped = fs
  .readFileSync(schemaPath, 'utf8')
  .split('\n')
  .map((line) => line.replace(/--.*$/, ''))
  .join('\n');

const statements = stripped
  .split(';')
  .map((s) => s.trim())
  .filter(Boolean);

// Forward-reference safety: any ALTER that REFERENCES a table created
// later in this file must run AFTER that CREATE. Naive order works for
// the current schema (every CREATE TABLE referenced by an ALTER appears
// before the ALTER in the file), BUT there are two ALTERs that escape
// that rule: the `shifts.job_id REFERENCES jobs(id)` ALTER on line 73
// runs before the CREATE TABLE jobs on line 207, and similarly for
// `users.location_id REFERENCES locations(id)` on line 192 vs. CREATE
// TABLE locations on line 185 (actually fine — locations is first) —
// so the only one that breaks fresh-DB applies is the jobs one.
//
// Simple, robust fix: run all CREATE TABLE / CREATE INDEX first, then
// ALTER TABLE. CREATE INDEX statements are harmless to run first (the
// table they reference will exist by then).
const creates = statements.filter((s) => /^(CREATE|ALTER)\s+(TABLE|INDEX|UNIQUE INDEX)/i.test(s) && /^CREATE/i.test(s));
const alters = statements.filter((s) => /^ALTER\s+(TABLE|VIEW)/i.test(s));
const other = statements.filter((s) => !creates.includes(s) && !alters.includes(s));

async function runPass(label, list) {
  let ok = 0;
  let fail = 0;
  for (const statement of list) {
    try {
      await sql.query(statement);
      ok++;
    } catch (err) {
      fail++;
      console.error(`[${label}] FAIL:`, statement.slice(0, 120).replace(/\s+/g, ' '));
      console.error(`         ${err.message}`);
    }
  }
  console.log(`[${label}] ok=${ok} fail=${fail}`);
  return fail === 0;
}

async function main() {
  const a = await runPass('CREATE', creates);
  const b = await runPass('ALTER', alters);
  const c = await runPass('OTHER', other);
  console.log(`Applied ${creates.length + alters.length + other.length} statements from db/schema.sql.`);
  if (!(a && b && c)) process.exit(1);
}

main().catch((err) => {
  console.error('Schema apply failed:', err);
  process.exit(1);
});
