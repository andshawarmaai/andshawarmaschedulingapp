#!/usr/bin/env node
// Deployment wizard: `npm run setup` from a clean checkout with no prior
// context — a fresh Vercel account, a fresh GitHub fork, run by a human
// or an AI agent. Every step checks current state before acting, so this
// is safe to re-run: it picks up wherever it left off (e.g. after
// `vercel login` finishes in a browser, or after approving Neon's
// marketplace terms), skipping whatever's already done.
import { execSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import crypto from 'node:crypto';

function sh(cmd) {
  execSync(cmd, { stdio: 'inherit' });
}
function shQuiet(cmd) {
  try {
    return execSync(cmd, { stdio: ['ignore', 'pipe', 'ignore'] }).toString();
  } catch {
    return null;
  }
}
function step(label) {
  console.log(`\n\x1b[1m→ ${label}\x1b[0m`);
}
function fail(message) {
  console.error(`\n${message}`);
  process.exit(1);
}

console.log('&Shawarma setup wizard\n');

// 1. Vercel login
const whoami = shQuiet('vercel whoami');
if (!whoami) {
  fail('Not logged into Vercel. Run `vercel login`, then re-run `npm run setup`.');
}
console.log(`Logged into Vercel as: ${whoami.trim()}`);

// 2. Link the project
if (!fs.existsSync('.vercel/project.json')) {
  step('Linking Vercel project (creates one if none exists)...');
  sh('vercel link --yes');
} else {
  const proj = JSON.parse(fs.readFileSync('.vercel/project.json', 'utf8'));
  console.log(`Already linked to Vercel project: ${proj.projectName}`);
}

// 3. Neon database via Vercel's marketplace integration
let envList = shQuiet('vercel env ls production') || '';
if (!envList.includes('DATABASE_URL')) {
  step('Provisioning a Neon database (Vercel marketplace integration)...');
  const result = spawnSync('vercel', ['integration', 'add', 'neon', '--non-interactive'], { stdio: 'inherit' });
  if (result.status !== 0) {
    fail(
      'Could not provision Neon non-interactively — first-time installs sometimes need a one-time\n' +
      'browser approval of marketplace terms. Run `vercel integration add neon` yourself, complete\n' +
      'any prompt it opens, then re-run `npm run setup`.'
    );
  }
  envList = shQuiet('vercel env ls production') || '';
} else {
  console.log('DATABASE_URL already set on the project.');
}

// 4. SESSION_SECRET
if (!envList.includes('SESSION_SECRET')) {
  step('Generating SESSION_SECRET...');
  const secret = crypto.randomBytes(32).toString('hex');
  const result = spawnSync('vercel', ['env', 'add', 'SESSION_SECRET', 'production'], {
    input: secret,
    stdio: ['pipe', 'inherit', 'inherit'],
  });
  if (result.status !== 0) fail('Could not set SESSION_SECRET. Run `vercel env add SESSION_SECRET production` manually, then re-run `npm run setup`.');
} else {
  console.log('SESSION_SECRET already set.');
}

// 5. Pull env vars locally so the next two steps can reach the database
step('Pulling environment variables to .env.local...');
sh('vercel env pull .env.local --yes --environment=production');

// 6. Apply schema (idempotent — every statement uses IF NOT EXISTS)
step('Applying database schema...');
sh('bash -c "set -a && source .env.local && set +a && node db/apply-schema.mjs"');

// 7. Seed the first accounts (no-op if users already exist)
step('Seeding accounts (no-op if the users table already has rows)...');
sh('bash -c "set -a && source .env.local && set +a && node db/seed.mjs"');

// 8. Deploy
step('Deploying to production...');
sh('vercel --prod --yes');

console.log(
  '\nSetup complete. Log in with one of the accounts printed above, and confirm the schedule loads.\n' +
  'Optional: set LLM_PROVIDER + an API key (see .env.example) to enable natural-language Telegram messages.'
);
