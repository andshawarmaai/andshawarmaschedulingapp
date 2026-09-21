// Create a staff test account so we can verify the staff experience.
import fs from 'node:fs';
import { neon } from '@neondatabase/serverless';
import bcrypt from 'bcryptjs';
import crypto from 'node:crypto';

const envFile = '/Users/testuser/.env.local';
for (const line of fs.readFileSync(envFile, 'utf8').split('\n')) {
  const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.+)$/);
  if (m) {
    let v = m[2].trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    process.env[m[1]] = v;
  }
}

const sql = neon(process.env.DATABASE_URL);

const existing = await sql`SELECT id, username, role FROM users WHERE username = 'staff1'`;
console.log('existing staff1:', existing);

if (existing.length === 0) {
  const passwordHash = bcrypt.hashSync('staff1', 10);
  const id = crypto.randomUUID();
  await sql`
    INSERT INTO users (id, username, password_hash, display_name, role, email, phone, disabled, created_at)
    VALUES (${id}, 'staff1', ${passwordHash}, 'Sam Staff', 'staff', null, null, false, NOW())
  `;
  console.log(`Created staff1/staff1 (role=staff)`);
} else {
  console.log('staff1 already exists, leaving as is');
}
