// Local file-backed data store. Used automatically whenever DATABASE_URL is
// not set (local dev / previewing this app without Neon wired up yet). Same
// function signatures as neon.js so the rest of the app never knows which
// backend is in use — see db/index.js.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import bcrypt from 'bcryptjs';
import { ORIGINAL_ROSTER } from '../../../db/roster.mjs';

const DATA_FILE = path.join(process.cwd(), 'db', '.local-data.json');

function id() {
  return crypto.randomUUID();
}

function seedData() {
  const now = new Date().toISOString();
  // Test-only convenience: local dev password == username, matching the
  // test deployment's seeded accounts. Never do this for a real deployment.
  const users = ORIGINAL_ROSTER.map((u) => ({
    id: id(),
    username: u.username,
    password_hash: bcrypt.hashSync(u.username, 10),
    display_name: u.display_name,
    role: u.role,
    email: u.email,
    phone: u.phone,
    disabled: false,
    created_at: now,
  }));
  return {
    users,
    shifts: [],
    time_off_requests: [],
    swap_posts: [],
    swap_claims: [],
    shift_requests: [],
    shift_imports: [],
    api_keys: [],
    password_reset_requests: [],
    telegram_bots: [],
    day_caps: [],
  };
}

function load() {
  if (!fs.existsSync(DATA_FILE)) {
    const initial = seedData();
    fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });
    fs.writeFileSync(DATA_FILE, JSON.stringify(initial, null, 2));
    // eslint-disable-next-line no-console
    console.log(`[local-db] Seeded ${DATA_FILE} with the original roster (${initial.users.length} users) — each account's dev password matches its username (e.g. ray / ray).`);
    return initial;
  }
  const data = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  if (!data.shift_requests) data.shift_requests = [];
  if (!data.shift_imports) data.shift_imports = [];
  if (!data.api_keys) data.api_keys = [];
  if (!data.password_reset_requests) data.password_reset_requests = [];
  if (!data.telegram_bots) data.telegram_bots = [];
  return data;
}

function save(data) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
}

// ----- users -----

export async function getUserByUsername(username) {
  return load().users.find((u) => u.username === username) || null;
}

export async function getUserById(userId) {
  return load().users.find((u) => u.id === userId) || null;
}

export async function listUsers() {
  return load().users.slice().sort((a, b) => a.display_name.localeCompare(b.display_name));
}

export async function createUser({ username, password, display_name, role, email, phone }) {
  const d = load();
  if (d.users.some((u) => u.username === username)) {
    const err = new Error('Username already taken');
    err.code = 'DUPLICATE';
    throw err;
  }
  const user = {
    id: id(),
    username,
    password_hash: bcrypt.hashSync(password, 10),
    display_name,
    role,
    email: email || null,
    phone: phone || null,
    disabled: false,
    created_at: new Date().toISOString(),
  };
  d.users.push(user);
  save(d);
  return user;
}

export async function updateUser(userId, updates) {
  const d = load();
  const u = d.users.find((x) => x.id === userId);
  if (!u) return null;
  if (updates.display_name !== undefined) u.display_name = updates.display_name;
  if (updates.phone !== undefined) u.phone = updates.phone;
  if (updates.email !== undefined) u.email = updates.email;
  if (updates.role !== undefined) u.role = updates.role;
  if (updates.disabled !== undefined) u.disabled = updates.disabled;
  if (updates.password) u.password_hash = bcrypt.hashSync(updates.password, 10);
  save(d);
  return u;
}

export async function deleteUser(userId) {
  const d = load();
  d.users = d.users.filter((u) => u.id !== userId);
  d.shifts.forEach((s) => {
    if (s.user_id === userId) s.user_id = null;
  });
  save(d);
  return true;
}

// ----- shifts -----

export async function listShifts() {
  return load()
    .shifts.slice()
    .sort((a, b) => (a.date + a.start_time).localeCompare(b.date + b.start_time));
}

export async function getShiftById(shiftId) {
  return load().shifts.find((s) => s.id === shiftId) || null;
}

export async function createShift({ user_id, date, start_time, end_time, department, notes, import_id }) {
  const d = load();
  const shift = {
    id: id(),
    user_id: user_id || null,
    date,
    start_time,
    end_time,
    department: department || null,
    notes: notes || null,
    import_id: import_id || null,
    created_at: new Date().toISOString(),
  };
  d.shifts.push(shift);
  save(d);
  return shift;
}

export async function updateShift(shiftId, updates) {
  const d = load();
  const s = d.shifts.find((x) => x.id === shiftId);
  if (!s) return null;
  Object.assign(s, updates);
  save(d);
  return s;
}

export async function deleteShift(shiftId) {
  const d = load();
  d.shifts = d.shifts.filter((s) => s.id !== shiftId);
  d.swap_posts = d.swap_posts.filter((p) => p.shift_id !== shiftId);
  d.shift_requests = d.shift_requests.filter((r) => r.shift_id !== shiftId);
  save(d);
  return true;
}

// ----- shift requests (staff request -> admin/manager approval) -----

export async function listShiftRequests() {
  return load()
    .shift_requests.slice()
    .sort((a, b) => b.created_at.localeCompare(a.created_at));
}

export async function getShiftRequestById(reqId) {
  return load().shift_requests.find((r) => r.id === reqId) || null;
}

export async function createShiftRequest({ user_id, action, shift_id, date, start_time, end_time, department, notes }) {
  const d = load();
  const row = {
    id: id(),
    user_id,
    action,
    shift_id: shift_id || null,
    date: date || null,
    start_time: start_time || null,
    end_time: end_time || null,
    department: department || null,
    notes: notes || null,
    status: 'pending',
    denial_reason: null,
    created_at: new Date().toISOString(),
  };
  d.shift_requests.push(row);
  save(d);
  return row;
}

export async function updateShiftRequest(reqId, updates) {
  const d = load();
  const row = d.shift_requests.find((r) => r.id === reqId);
  if (!row) return null;
  Object.assign(row, updates);
  save(d);
  return row;
}

export async function deleteShiftRequest(reqId) {
  const d = load();
  d.shift_requests = d.shift_requests.filter((r) => r.id !== reqId);
  save(d);
  return true;
}

// Approves a shift request: applies the create/update/delete to the shifts
// table, then marks the request approved.
export async function approveShiftRequestTx(reqId) {
  const d = load();
  const req = d.shift_requests.find((r) => r.id === reqId);
  if (!req) return { error: 'not_found' };
  if (req.status !== 'pending') return { error: 'already_resolved', status: req.status };

  if (req.action === 'create') {
    d.shifts.push({
      id: id(),
      user_id: req.user_id,
      date: req.date,
      start_time: req.start_time,
      end_time: req.end_time,
      department: req.department,
      notes: req.notes,
      created_at: new Date().toISOString(),
    });
  } else if (req.action === 'update') {
    const shift = d.shifts.find((s) => s.id === req.shift_id);
    if (!shift) return { error: 'shift_missing' };
    shift.date = req.date;
    shift.start_time = req.start_time;
    shift.end_time = req.end_time;
    shift.department = req.department;
    shift.notes = req.notes;
  } else if (req.action === 'delete') {
    d.shifts = d.shifts.filter((s) => s.id !== req.shift_id);
    d.swap_posts = d.swap_posts.filter((p) => p.shift_id !== req.shift_id);
  }

  req.status = 'approved';
  save(d);
  return { ok: true };
}

// ----- shift imports (bulk CSV, admin/manager only) -----

export async function listShiftImports() {
  return load()
    .shift_imports.slice()
    .sort((a, b) => b.created_at.localeCompare(a.created_at));
}

export async function createShiftImport({ uploaded_by, filename, row_count }) {
  const d = load();
  const row = {
    id: id(),
    uploaded_by,
    filename: filename || null,
    row_count,
    created_at: new Date().toISOString(),
  };
  d.shift_imports.push(row);
  save(d);
  return row;
}

// Deletes the import batch and every shift it created (mirrors the
// ON DELETE CASCADE foreign key in the Postgres schema) — this is the
// "undo this upload" action in the admin file-management UI.
export async function deleteShiftImport(importId) {
  const d = load();
  d.shifts = d.shifts.filter((s) => s.import_id !== importId);
  d.shift_imports = d.shift_imports.filter((i) => i.id !== importId);
  save(d);
  return true;
}

// ----- time off -----

export async function listTimeOff() {
  return load()
    .time_off_requests.slice()
    .sort((a, b) => b.created_at.localeCompare(a.created_at));
}

export async function getTimeOffById(toId) {
  return load().time_off_requests.find((x) => x.id === toId) || null;
}

export async function createTimeOff({ user_id, start_date, end_date, reason }) {
  const d = load();
  const row = {
    id: id(),
    user_id,
    start_date,
    end_date,
    reason: reason || null,
    status: 'pending',
    denial_reason: null,
    created_at: new Date().toISOString(),
  };
  d.time_off_requests.push(row);
  save(d);
  return row;
}

export async function updateTimeOff(toId, updates) {
  const d = load();
  const row = d.time_off_requests.find((x) => x.id === toId);
  if (!row) return null;
  Object.assign(row, updates);
  save(d);
  return row;
}

export async function deleteTimeOff(toId) {
  const d = load();
  d.time_off_requests = d.time_off_requests.filter((x) => x.id !== toId);
  save(d);
  return true;
}

// ----- shift swap: posts + claims -----

export async function listSwapPosts() {
  return load()
    .swap_posts.slice()
    .sort((a, b) => b.created_at.localeCompare(a.created_at));
}

export async function getSwapPost(postId) {
  return load().swap_posts.find((p) => p.id === postId) || null;
}

export async function createSwapPost({ shift_id, user_id, reason }) {
  const d = load();
  const row = {
    id: id(),
    shift_id,
    user_id,
    reason: reason || null,
    status: 'open',
    created_at: new Date().toISOString(),
  };
  d.swap_posts.push(row);
  save(d);
  return row;
}

export async function updateSwapPost(postId, updates) {
  const d = load();
  const row = d.swap_posts.find((p) => p.id === postId);
  if (!row) return null;
  Object.assign(row, updates);
  save(d);
  return row;
}

export async function listSwapClaims() {
  return load()
    .swap_claims.slice()
    .sort((a, b) => b.created_at.localeCompare(a.created_at));
}

export async function getSwapClaim(claimId) {
  return load().swap_claims.find((c) => c.id === claimId) || null;
}

export async function createSwapClaim({ post_id, claimant_id, offer_shift_id }) {
  const d = load();
  const row = {
    id: id(),
    post_id,
    claimant_id,
    offer_shift_id: offer_shift_id || null,
    status: 'pending',
    created_at: new Date().toISOString(),
  };
  d.swap_claims.push(row);
  save(d);
  return row;
}

export async function updateSwapClaim(claimId, updates) {
  const d = load();
  const row = d.swap_claims.find((c) => c.id === claimId);
  if (!row) return null;
  Object.assign(row, updates);
  save(d);
  return row;
}

// Approves a claim: flips the posted shift to the claimant, flips the
// claimant's offered shift back to the original poster (if any), closes the
// post, and denies any other pending claims on that post.
export async function approveSwapClaimTx(claimId) {
  const d = load();
  const claim = d.swap_claims.find((c) => c.id === claimId);
  if (!claim) return { error: 'not_found' };
  if (claim.status !== 'pending') return { error: 'already_resolved', status: claim.status };
  const post = d.swap_posts.find((p) => p.id === claim.post_id);
  if (!post || post.status !== 'open') return { error: 'post_closed' };
  const shift = d.shifts.find((s) => s.id === post.shift_id);
  if (!shift) return { error: 'shift_missing' };

  shift.user_id = claim.claimant_id;
  if (claim.offer_shift_id) {
    const offer = d.shifts.find((s) => s.id === claim.offer_shift_id);
    if (offer) offer.user_id = post.user_id;
  }
  claim.status = 'approved';
  post.status = 'closed';
  d.swap_claims.forEach((c) => {
    if (c.post_id === post.id && c.id !== claim.id && c.status === 'pending') c.status = 'denied';
  });
  save(d);
  return { ok: true };
}

// ----- day caps -----

export async function listDayCaps() {
  return load().day_caps.slice();
}

export async function upsertDayCap({ date, window_start, window_end, max_shifts, note }) {
  const d = load();
  let row = d.day_caps.find(
    (c) => c.date === date && c.window_start === window_start && c.window_end === window_end
  );
  if (row) {
    row.max_shifts = max_shifts;
    row.note = note || null;
  } else {
    row = { id: id(), date, window_start, window_end, max_shifts, note: note || null };
    d.day_caps.push(row);
  }
  save(d);
  return row;
}

export async function deleteDayCap({ date, window_start, window_end }) {
  const d = load();
  d.day_caps = d.day_caps.filter(
    (c) => !(c.date === date && c.window_start === window_start && c.window_end === window_end)
  );
  save(d);
  return true;
}

// ----- API keys (programmatic access, e.g. an AI agent posting a CSV) -----

export async function listApiKeys() {
  return load()
    .api_keys.slice()
    .sort((a, b) => b.created_at.localeCompare(a.created_at));
}

export async function findApiKeyByPrefix(prefix) {
  return load().api_keys.find((k) => k.key_prefix === prefix && !k.revoked) || null;
}

export async function createApiKeyRecord({ label, key_prefix, key_hash, created_by }) {
  const d = load();
  const row = {
    id: id(),
    label,
    key_prefix,
    key_hash,
    created_by,
    created_at: new Date().toISOString(),
    last_used_at: null,
    revoked: false,
  };
  d.api_keys.push(row);
  save(d);
  return row;
}

export async function touchApiKey(keyId) {
  const d = load();
  const row = d.api_keys.find((k) => k.id === keyId);
  if (row) { row.last_used_at = new Date().toISOString(); save(d); }
}

export async function revokeApiKey(keyId) {
  const d = load();
  const row = d.api_keys.find((k) => k.id === keyId);
  if (!row) return false;
  row.revoked = true;
  save(d);
  return true;
}

// ----- password reset requests -----

export async function createPasswordResetRequest(userId) {
  const d = load();
  const row = { id: id(), user_id: userId, requested_at: new Date().toISOString(), resolved_at: null, resolved_by: null };
  d.password_reset_requests.push(row);
  save(d);
  return row;
}
export async function listPasswordResetRequests() {
  return load()
    .password_reset_requests.slice()
    .sort((a, b) => b.requested_at.localeCompare(a.requested_at));
}
export async function resolvePasswordResetRequest(requestId, resolvedBy) {
  const d = load();
  const row = d.password_reset_requests.find((r) => r.id === requestId);
  if (!row) return null;
  row.resolved_at = new Date().toISOString();
  row.resolved_by = resolvedBy || null;
  save(d);
  return row;
}

// ----- Telegram bots (one per admin, linked via /start) -----

export async function listTelegramBots() {
  return load()
    .telegram_bots.slice()
    .sort((a, b) => b.created_at.localeCompare(a.created_at));
}

export async function listTelegramBotsForUser(userId) {
  return load().telegram_bots.filter((b) => b.user_id === userId && !b.revoked);
}

export async function getTelegramBotById(botId) {
  return load().telegram_bots.find((b) => b.id === botId) || null;
}

export async function getTelegramBotByWebhookSecret(secret) {
  return load().telegram_bots.find((b) => b.webhook_secret === secret && !b.revoked) || null;
}

export async function createTelegramBot({ user_id, bot_token, bot_username, webhook_secret }) {
  const d = load();
  const row = {
    id: id(),
    user_id,
    bot_token,
    bot_username: bot_username || null,
    webhook_secret,
    chat_id: null,
    linked_at: null,
    last_used_at: null,
    revoked: false,
    created_at: new Date().toISOString(),
  };
  d.telegram_bots.push(row);
  save(d);
  return row;
}

export async function linkTelegramBotChat(botId, chatId) {
  const d = load();
  const row = d.telegram_bots.find((b) => b.id === botId);
  if (!row) return null;
  row.chat_id = String(chatId);
  row.linked_at = new Date().toISOString();
  save(d);
  return row;
}

export async function touchTelegramBot(botId) {
  const d = load();
  const row = d.telegram_bots.find((b) => b.id === botId);
  if (row) { row.last_used_at = new Date().toISOString(); save(d); }
}

export async function revokeTelegramBot(botId) {
  const d = load();
  const row = d.telegram_bots.find((b) => b.id === botId);
  if (!row) return false;
  row.revoked = true;
  save(d);
  return true;
}
