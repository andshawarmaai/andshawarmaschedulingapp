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
const SEED_PASSWORD = 'shawarma-dev';

function id() {
  return crypto.randomUUID();
}

function seedData() {
  const now = new Date().toISOString();
  const passwordHash = bcrypt.hashSync(SEED_PASSWORD, 10);
  const users = ORIGINAL_ROSTER.map((u) => ({
    id: id(),
    username: u.username,
    password_hash: passwordHash,
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
    day_caps: [],
  };
}

function load() {
  if (!fs.existsSync(DATA_FILE)) {
    const initial = seedData();
    fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });
    fs.writeFileSync(DATA_FILE, JSON.stringify(initial, null, 2));
    // eslint-disable-next-line no-console
    console.log(`[local-db] Seeded ${DATA_FILE} with the original roster (${initial.users.length} users) — every account's dev password is "${SEED_PASSWORD}" (e.g. ray / ${SEED_PASSWORD}).`);
    return initial;
  }
  return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
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

export async function createShift({ user_id, date, start_time, end_time, department, notes }) {
  const d = load();
  const shift = {
    id: id(),
    user_id: user_id || null,
    date,
    start_time,
    end_time,
    department: department || null,
    notes: notes || null,
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
