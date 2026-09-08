// One-time setup script for a fresh Neon database.
//
//   1. Run schema.sql against your database (psql, Neon SQL editor, etc.)
//   2. Set DATABASE_URL in your environment (or a local .env this script reads)
//   3. node db/seed.mjs
//
// Seeds the original &Shawarma roster (recovered from
// db/backups/snapshot-20260706-161653.json) if `users` is empty. Safe to
// re-run — it does nothing if any user already exists. Each account gets a
// freshly generated random password, printed once below; have everyone
// change theirs after first login (Manage -> Users -> Edit).

import crypto from 'node:crypto';
import { neon } from '@neondatabase/serverless';
import bcrypt from 'bcryptjs';
import { ORIGINAL_ROSTER } from './roster.mjs';

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error('DATABASE_URL is not set. Export it (or put it in .env) and re-run.');
  process.exit(1);
}

const sql = neon(DATABASE_URL);

function randomPassword() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789';
  const bytes = crypto.randomBytes(12);
  return Array.from(bytes, (b) => chars[b % chars.length]).join('');
}

async function main() {
  const [{ count }] = await sql`SELECT COUNT(*)::int AS count FROM users`;
  if (count > 0) {
    console.log(`users table already has ${count} row(s) — not seeding. Nothing to do.`);
    return;
  }

  const created = [];
  for (const person of ORIGINAL_ROSTER) {
    const password = randomPassword();
    const password_hash = bcrypt.hashSync(password, 10);
    await sql`
      INSERT INTO users (username, password_hash, display_name, role, email, phone)
      VALUES (${person.username}, ${password_hash}, ${person.display_name}, ${person.role}, ${person.email}, ${person.phone})
    `;
    created.push({ ...person, password });
  }

  console.log(`Created ${created.length} accounts:\n`);
  for (const u of created) {
    console.log(`  ${u.username.padEnd(10)} ${u.role.padEnd(8)} ${u.display_name.padEnd(16)} password: ${u.password}`);
  }
  console.log('\nShare each password with its owner and have them change it after first login (Manage -> Users -> Edit).');
}

main().catch((err) => {
  console.error('Seed failed:', err);
  process.exit(1);
});
