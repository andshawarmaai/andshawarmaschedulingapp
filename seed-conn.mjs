import { readFileSync } from 'fs';
import pg from 'pg';

const env = readFileSync('/Users/testuser/andshawarma-scheduling/.env.local', 'utf8');
const m = env.match(/DATABASE_URL=(.+)/);
const conn = m[1].trim();

const client = new pg.Client({ connectionString: conn, ssl: { rejectUnauthorized: false } });
await client.connect();

const u = await client.query("SELECT id, username, display_name, role FROM users ORDER BY id");
console.log('USERS:');
console.table(u.rows);

const s = await client.query("SELECT id, user_id, date, start_time, end_time, notes FROM shifts WHERE date BETWEEN '2026-09-21' AND '2026-10-25' ORDER BY date, start_time");
console.log('SHIFTS next 30 days:');
console.table(s.rows);

await client.end();