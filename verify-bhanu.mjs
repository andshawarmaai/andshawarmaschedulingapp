import { neon } from '@neondatabase/serverless';
import { readFileSync } from 'node:fs';
const env = readFileSync('.env.local', 'utf8');
const m = env.match(/^DATABASE_URL="([^"]+)"/m);
const sql = neon(m[1]);

const BHANU_ID = '58dfdec9-cda1-4a1a-8327-2667afc787c2';

console.log('=== Direct DB verification of Bhanu\'s September 2026 shifts ===\n');

const shifts = await sql`
  SELECT id, date, start_time, end_time, notes, created_at
  FROM shifts
  WHERE user_id = ${BHANU_ID}
    AND date BETWEEN '2026-09-01' AND '2026-09-30'
  ORDER BY date ASC
`;

const NEW_NOTE = 'scheduled via Hermes agent demo';
let newCount = 0;
let existingCount = 0;

for (const s of shifts) {
  const dow = ['Mon','Tue','Wed','Thu','Fri','Sat','Sun'][new Date(s.date + 'T00:00:00').getDay()];
  const isNew = (s.notes || '').includes('Hermes');
  if (isNew) newCount++; else existingCount++;
  const flag = isNew ? '🆕 NEW' : '   ';
  console.log(`  ${s.date} (${dow}) ${s.start_time}-${s.end_time}  ${flag}`);
  console.log(`    id: ${s.id}`);
  console.log(`    notes: "${s.notes || '(none)'}"`);
  console.log(`    created_at: ${s.created_at}`);
  console.log('');
}

console.log(`Summary: ${newCount} new (mine) + ${existingCount} pre-existing = ${shifts.length} total`);
