#!/usr/bin/env node
// &Shawarma Schedule — local Hermes relay.
//
// Runs on the restaurant's own computer and connects the app's chat to the
// Hermes agent installed there. No tunnel and no open ports: it only makes
// outgoing HTTPS requests, asking the app for new chat messages every few
// seconds, running Hermes on each one, and posting Hermes's answer back. The
// app then carries out any schedule changes as the person who asked, with
// their own permissions.
//
// Installed by install-relay.sh (Manage → Chat Bot → Set up Hermes).
// Env: SHAWARMA_URL, SHAWARMA_API_KEY, optional HERMES_BIN, HERMES_TOOLSETS,
// POLL_SECONDS. Requires Node 18+. No dependencies.
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, mkdir, readdir, stat, writeFile, readFile, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';

const BASE = String(process.env.SHAWARMA_URL || '').replace(/\/$/, '');
const KEY = process.env.SHAWARMA_API_KEY;
const POLL_MS = Math.max(1, Number(process.env.POLL_SECONDS) || 3) * 1000;
const HERMES_TIMEOUT_MS = 5 * 60 * 1000;
const localHermes = path.join(homedir(), '.local/bin/hermes');
const HERMES_BIN = process.env.HERMES_BIN || (existsSync(localHermes) ? localHermes : 'hermes');
const SKILL_NAME = 'andshawarma-schedule';

if (!BASE || !KEY) {
  console.error('Set SHAWARMA_URL and SHAWARMA_API_KEY (the installer does this for you).');
  process.exit(1);
}

const log = (...args) => console.log(`[${new Date().toLocaleTimeString()}]`, ...args);

async function api(method, route, body) {
  const res = await fetch(BASE + route, {
    method,
    headers: { Authorization: `Bearer ${KEY}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw new Error(`${method} ${route} -> ${res.status} ${(await res.text()).slice(0, 200)}`);
  return res;
}

// ---- Friendly failures: retry quietly, then a natural reply ----------------
const RETRY_DELAYS_MS = [20_000, 60_000];
const attempts = new Map(); // message id -> { count, nextAt }
function friendlyFailure(detail) {
  const d = String(detail).toLowerCase();
  if (/usage limit|token plan|credits|quota|insufficient|billing|payment/.test(d)) return "I can't reply right now because the AI service I use has reached its usage limit. Once it's topped up, send your message again and I'll pick it up.";
  if (/rate.?limit|429|overloaded|temporarily unavailable|503|502/.test(d)) return "I'm getting a lot of requests right now and couldn't answer in time. Please send that again in a minute.";
  if (/timed? ?out|longer than/.test(d)) return 'That took longer than I expected, so I stopped. Try asking for one change at a time.';
  if (/could not start hermes|enoent/.test(d)) return "I can't reach the assistant on the manager's computer right now. Make sure it's on and connected, then try again.";
  return "Sorry, I couldn't finish that one. Please try again in a moment.";
}

// ---- Files ------------------------------------------------------------------
const OUTBOX_MAX_FILES = 5;
const OUTBOX_MAX_BYTES = 3 * 1024 * 1024;
const TYPES = { csv: 'text/csv', xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', pdf: 'application/pdf', txt: 'text/plain', json: 'application/json', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg' };

async function downloadAttachments(message, dir) {
  const files = [];
  for (const a of message.attachments || []) {
    try {
      const res = await api('GET', a.url);
      const target = path.join(dir, `${files.length + 1}-${String(a.name || 'file').replace(/[^\w.\-]+/g, '_')}`);
      await writeFile(target, Buffer.from(await res.arrayBuffer()));
      files.push({ ...a, path: target });
    } catch (err) {
      log(`could not download ${a.name}: ${err.message}`);
    }
  }
  return files;
}

async function collectOutbox(outbox) {
  const files = [];
  for (const name of (await readdir(outbox).catch(() => [])).slice(0, OUTBOX_MAX_FILES)) {
    const full = path.join(outbox, name);
    const info = await stat(full).catch(() => null);
    if (!info?.isFile()) continue;
    if (info.size > OUTBOX_MAX_BYTES) { log(`skipped ${name}: larger than 3 MB`); continue; }
    files.push({ name, content_type: TYPES[name.split('.').pop().toLowerCase()] || 'application/octet-stream', content_b64: (await readFile(full)).toString('base64') });
  }
  if (files.length) log(`attaching ${files.length} file(s)`);
  return files;
}

// ---- Hermes -----------------------------------------------------------------
function runHermes(promptFile, outbox) {
  return new Promise((resolve, reject) => {
    const args = ['chat', '--oneshot', '-Q', '--query-file', promptFile];
    if (process.env.HERMES_TOOLSETS) args.push('-t', process.env.HERMES_TOOLSETS);
    const proc = spawn(HERMES_BIN, args, {
      env: { ...process.env, SHAWARMA_URL: BASE, SHAWARMA_API_KEY: KEY, SHAWARMA_OUTBOX: outbox },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    let err = '';
    proc.stdout.on('data', (d) => { out += d; });
    proc.stderr.on('data', (d) => { err += d; });
    const timer = setTimeout(() => { proc.kill('SIGTERM'); reject(new Error('Hermes took longer than 5 minutes.')); }, HERMES_TIMEOUT_MS);
    proc.on('error', (e) => { clearTimeout(timer); reject(new Error(`Could not start Hermes (${HERMES_BIN}): ${e.message}`)); });
    proc.on('close', (code) => {
      clearTimeout(timer);
      // Hermes prints config warnings on stdout; keep them out of the chat.
      const reply = out.split('\n').filter((line) => !/^\s*(Warning|WARN|DEBUG|INFO)\b[: ]/.test(line)).join('\n').trim();
      if (code === 0 && reply) resolve(reply);
      else reject(new Error(`Hermes exited ${code}: ${`${out}\n${err}`.replace(/session_id:\s*\S+/g, '').trim().slice(-600)}`));
    });
  });
}

const inFlight = new Set();

async function handle(message) {
  inFlight.add(message.id);
  const dir = await mkdtemp(path.join(tmpdir(), 'shawarma-'));
  log(`message ${message.id.slice(0, 8)}${message.attachments?.length ? ` + ${message.attachments.length} file(s)` : ''}`);
  try {
    const files = await downloadAttachments(message, dir);
    const outbox = path.join(dir, 'outbox');
    await mkdir(outbox);
    const promptFile = path.join(dir, 'prompt.txt');
    await writeFile(promptFile, [
      message.prompt,
      files.length ? `Attached files (read them from disk):\n${files.map((f) => `- ${f.name}: ${f.path}`).join('\n')}` : '',
      `If a file would help the person (for example a schedule spreadsheet or PDF), save it in ${outbox} and mention it; it will be attached to your reply.`,
    ].filter(Boolean).join('\n\n'));

    let reply;
    let ok = true;
    try {
      reply = await runHermes(promptFile, outbox);
      attempts.delete(message.id);
    } catch (err) {
      log(err.message);
      const tries = (attempts.get(message.id)?.count || 0) + 1;
      if (tries <= RETRY_DELAYS_MS.length) {
        attempts.set(message.id, { count: tries, nextAt: Date.now() + RETRY_DELAYS_MS[tries - 1] });
        log(`will retry in ${RETRY_DELAYS_MS[tries - 1] / 1000}s`);
        return;
      }
      attempts.delete(message.id);
      ok = false;
      reply = friendlyFailure(err.message);
    }
    await api('POST', message.reply_url, { reply, status: ok ? 'answered' : 'failed', files: ok ? await collectOutbox(outbox) : [] });
    log(`replied (${ok ? 'ok' : 'failed'})`);
  } catch (err) {
    log(`error: ${err.message}`);
  } finally {
    await rm(dir, { recursive: true, force: true });
    inFlight.delete(message.id);
  }
}

async function poll() {
  try {
    const res = await api('GET', '/api/agent/relay/inbox');
    const { messages = [] } = await res.json();
    for (const m of messages) {
      const retry = attempts.get(m.id);
      if (inFlight.has(m.id) || (retry && retry.nextAt > Date.now())) continue;
      await handle(m);
    }
  } catch (err) {
    log(`poll failed: ${err.message}`);
  }
  setTimeout(poll, POLL_MS);
}

// ---- Stay current: relay + skill update themselves from the app ------------
const SELF = fileURLToPath(import.meta.url);
async function refreshSkill() {
  try {
    const res = await fetch(`${BASE}/hermes-skill/SKILL.md`, { cache: 'no-store' });
    if (!res.ok) return;
    const latest = await res.text();
    if (!latest.startsWith('---')) return;
    for (const dir of [path.join(homedir(), '.hermes/skills', SKILL_NAME), path.join(homedir(), '.claude/skills', SKILL_NAME)]) {
      if (!existsSync(dir)) continue;
      const file = path.join(dir, 'SKILL.md');
      if ((await readFile(file, 'utf8').catch(() => '')) !== latest) {
        await writeFile(file, latest);
        log(`Updated skill in ${dir}`);
      }
    }
  } catch (err) {
    log(`skill refresh failed: ${err.message}`);
  }
}
async function selfUpdate() {
  try {
    const res = await fetch(`${BASE}/schedule-relay.mjs`, { cache: 'no-store' });
    if (res.ok) {
      const latest = await res.text();
      if (latest.includes('&Shawarma Schedule — local Hermes relay') && latest !== await readFile(SELF, 'utf8')) {
        await writeFile(SELF, latest);
        log('Updated to the latest relay; restarting.');
        process.exit(0);
      }
    }
  } catch (err) {
    log(`update check failed: ${err.message}`);
  }
  await refreshSkill();
  setTimeout(selfUpdate, 6 * 60 * 60 * 1000);
}

log(`&Shawarma Schedule relay started. App: ${BASE}  Hermes: ${HERMES_BIN}`);
poll();
setTimeout(selfUpdate, 60_000);
