import { neon } from '@neondatabase/serverless';
import { readFileSync } from 'node:fs';
const env = readFileSync('.env.local', 'utf8');
const m = env.match(/^DATABASE_URL="([^"]+)"/m);
const sql = neon(m[1]);

const total = await sql`SELECT COUNT(*)::int AS n FROM shifts WHERE date BETWEEN '2026-09-10' AND '2026-09-16'`;
console.log('Total shifts in Sept 10-16:', total[0].n);

const byDate = await sql`SELECT date, COUNT(*)::int AS n FROM shifts WHERE date BETWEEN '2026-09-10' AND '2026-09-16' GROUP BY date ORDER BY date`;
console.log('By date:');
for (const r of byDate) console.log(' ', r.date, '->', r.n);

const tpls = await sql`SELECT name FROM shift_templates ORDER BY name`;
console.log('\nTemplates:', tpls.length);
for (const t of tpls) console.log(' -', t.name);

const imps = await sql`SELECT id, filename, row_count, created_at FROM shift_imports ORDER BY created_at DESC LIMIT 5`;
console.log('\nRecent imports:');
for (const i of imps) console.log(' -', i.id, '|', i.filename, '| rows:', i.row_count, '|', i.created_at);
