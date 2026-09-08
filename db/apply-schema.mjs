// One-time setup script: applies db/schema.sql against DATABASE_URL.
// Every statement in schema.sql uses IF NOT EXISTS, so this is safe to
// re-run against a database that's already been set up — it just does
// nothing new.
//
//   DATABASE_URL=... node db/apply-schema.mjs

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

// Strip "--" line comments before splitting on ";" — several columns in
// schema.sql have inline comments that themselves contain a semicolon
// (e.g. "set when created by a bulk CSV import; deleting the import..."),
// which would otherwise cut a CREATE TABLE statement in half.
const withoutComments = fs
  .readFileSync(schemaPath, 'utf8')
  .split('\n')
  .map((line) => line.replace(/--.*$/, ''))
  .join('\n');

const statements = withoutComments
  .split(';')
  .map((s) => s.trim())
  .filter(Boolean);

async function main() {
  for (const statement of statements) {
    await sql.query(statement);
  }
  console.log(`Applied ${statements.length} statement(s) from db/schema.sql.`);
}

main().catch((err) => {
  console.error('Schema apply failed:', err);
  process.exit(1);
});
