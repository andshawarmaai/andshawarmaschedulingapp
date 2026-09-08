// Original &Shawarma roster, recovered from db/backups/snapshot-20260706-161653.json
// (the old app's last data export before the rewrite). Shared by the local
// dev seed (src/lib/db/local.js) and the Neon seed script (db/seed.mjs) so
// both start from the same crew. Passwords are generated fresh at seed time
// — the old bcrypt hashes weren't carried over.

export const ORIGINAL_ROSTER = [
  { username: 'ray', role: 'admin', display_name: 'Ray Ally', email: 'theRayally@gmail.com', phone: '+12624499088' },
  { username: 'azmeer', role: 'admin', display_name: 'Azmeer', email: 'azmeer@andshawarma.example', phone: '+15551234567' },
  { username: 'badar', role: 'admin', display_name: 'Badar Khokar', email: 'badar@andshawarma.example', phone: '+15551230003' },
  { username: 'jorge', role: 'staff', display_name: 'Jorge', email: 'jorge@andshawarma.example', phone: '+15551230004' },
  { username: 'jeremy', role: 'staff', display_name: 'Jeremy', email: 'jeremy@andshawarma.example', phone: '+15551230005' },
  { username: 'adnan', role: 'staff', display_name: 'Adnan', email: 'adnan@andshawarma.example', phone: '+15551230006' },
  { username: 'david', role: 'staff', display_name: 'David', email: 'david@andshawarma.example', phone: '+15551230007' },
  { username: 'albero', role: 'staff', display_name: 'Albero', email: 'albero@andshawarma.example', phone: '+15551230008' },
  { username: 'john', role: 'staff', display_name: 'John', email: 'john@andshawarma.example', phone: '+15551230009' },
  { username: 'sanaa', role: 'staff', display_name: 'Sanaa', email: 'sanaa@andshawarma.example', phone: '+15551230010' },
  { username: 'bhanu', role: 'staff', display_name: 'Bhanu', email: 'bhanu@andshawarma.example', phone: '+15551230011' },
];
