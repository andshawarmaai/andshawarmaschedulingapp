// Neon Postgres backend. Used automatically once DATABASE_URL is set (see
// db/index.js). Mirrors local.js function-for-function so API routes never
// need to know which backend is active. Run db/schema.sql against your Neon
// database once, then db/seed.mjs to create the first admin account.

import { neon } from '@neondatabase/serverless';
import bcrypt from 'bcryptjs';

// Lazy: db/index.js imports this module unconditionally (both backends are
// always evaluated so it can pick one), so neon() must not be called eagerly
// at import time — it throws immediately if DATABASE_URL is unset, which
// would break local dev even when the local backend is the one in use.
const sql = process.env.DATABASE_URL ? neon(process.env.DATABASE_URL) : null;

function row0(rows) {
  return rows[0] || null;
}

// ----- users -----

export async function getUserByUsername(username) {
  return row0(await sql`SELECT * FROM users WHERE username = ${username}`);
}

export async function getUserById(userId) {
  return row0(await sql`SELECT * FROM users WHERE id = ${userId}`);
}

export async function listUsers() {
  return sql`SELECT * FROM users ORDER BY display_name ASC`;
}

export async function createUser({ username, password, display_name, role, email, phone }) {
  const existing = await getUserByUsername(username);
  if (existing) {
    const err = new Error('Username already taken');
    err.code = 'DUPLICATE';
    throw err;
  }
  const password_hash = bcrypt.hashSync(password, 10);
  return row0(await sql`
    INSERT INTO users (username, password_hash, display_name, role, email, phone)
    VALUES (${username}, ${password_hash}, ${display_name}, ${role}, ${email || null}, ${phone || null})
    RETURNING *
  `);
}

export async function updateUser(userId, updates) {
  const u = await getUserById(userId);
  if (!u) return null;
  const merged = {
    display_name: updates.display_name ?? u.display_name,
    phone: updates.phone ?? u.phone,
    email: updates.email ?? u.email,
    role: updates.role ?? u.role,
    disabled: updates.disabled ?? u.disabled,
    password_hash: updates.password ? bcrypt.hashSync(updates.password, 10) : u.password_hash,
  };
  return row0(await sql`
    UPDATE users SET
      display_name = ${merged.display_name},
      phone = ${merged.phone},
      email = ${merged.email},
      role = ${merged.role},
      disabled = ${merged.disabled},
      password_hash = ${merged.password_hash}
    WHERE id = ${userId}
    RETURNING *
  `);
}

export async function deleteUser(userId) {
  await sql`UPDATE shifts SET user_id = NULL WHERE user_id = ${userId}`;
  await sql`DELETE FROM users WHERE id = ${userId}`;
  return true;
}

// ----- shifts -----

export async function listShifts() {
  return sql`SELECT * FROM shifts ORDER BY date ASC, start_time ASC`;
}

export async function getShiftById(shiftId) {
  return row0(await sql`SELECT * FROM shifts WHERE id = ${shiftId}`);
}

export async function createShift({ user_id, date, start_time, end_time, department, notes, import_id }) {
  return row0(await sql`
    INSERT INTO shifts (user_id, date, start_time, end_time, department, notes, import_id)
    VALUES (${user_id || null}, ${date}, ${start_time}, ${end_time}, ${department || null}, ${notes || null}, ${import_id || null})
    RETURNING *
  `);
}

export async function updateShift(shiftId, updates) {
  const s = await getShiftById(shiftId);
  if (!s) return null;
  const merged = {
    user_id: updates.user_id !== undefined ? updates.user_id : s.user_id,
    date: updates.date ?? s.date,
    start_time: updates.start_time ?? s.start_time,
    end_time: updates.end_time ?? s.end_time,
    department: updates.department !== undefined ? updates.department : s.department,
    notes: updates.notes !== undefined ? updates.notes : s.notes,
  };
  return row0(await sql`
    UPDATE shifts SET
      user_id = ${merged.user_id},
      date = ${merged.date},
      start_time = ${merged.start_time},
      end_time = ${merged.end_time},
      department = ${merged.department},
      notes = ${merged.notes}
    WHERE id = ${shiftId}
    RETURNING *
  `);
}

export async function deleteShift(shiftId) {
  await sql`DELETE FROM shifts WHERE id = ${shiftId}`;
  return true;
}

// ----- shift requests (staff request -> admin/manager approval) -----

export async function listShiftRequests() {
  return sql`SELECT * FROM shift_requests ORDER BY created_at DESC`;
}

export async function getShiftRequestById(reqId) {
  return row0(await sql`SELECT * FROM shift_requests WHERE id = ${reqId}`);
}

export async function createShiftRequest({ user_id, action, shift_id, date, start_time, end_time, department, notes }) {
  return row0(await sql`
    INSERT INTO shift_requests (user_id, action, shift_id, date, start_time, end_time, department, notes)
    VALUES (${user_id}, ${action}, ${shift_id || null}, ${date || null}, ${start_time || null}, ${end_time || null}, ${department || null}, ${notes || null})
    RETURNING *
  `);
}

export async function updateShiftRequest(reqId, updates) {
  const row = await getShiftRequestById(reqId);
  if (!row) return null;
  const status = updates.status ?? row.status;
  const denial_reason = updates.denial_reason !== undefined ? updates.denial_reason : row.denial_reason;
  return row0(await sql`
    UPDATE shift_requests SET status = ${status}, denial_reason = ${denial_reason}
    WHERE id = ${reqId}
    RETURNING *
  `);
}

export async function deleteShiftRequest(reqId) {
  await sql`DELETE FROM shift_requests WHERE id = ${reqId}`;
  return true;
}

// Not run inside a single DB transaction (see approveSwapClaimTx above for
// why) — guarded on status so a race can't double-apply.
export async function approveShiftRequestTx(reqId) {
  const req = await getShiftRequestById(reqId);
  if (!req) return { error: 'not_found' };
  if (req.status !== 'pending') return { error: 'already_resolved', status: req.status };

  if (req.action === 'create') {
    await sql`
      INSERT INTO shifts (user_id, date, start_time, end_time, department, notes)
      VALUES (${req.user_id}, ${req.date}, ${req.start_time}, ${req.end_time}, ${req.department}, ${req.notes})
    `;
  } else if (req.action === 'update') {
    const shift = await getShiftById(req.shift_id);
    if (!shift) return { error: 'shift_missing' };
    await sql`
      UPDATE shifts SET date = ${req.date}, start_time = ${req.start_time}, end_time = ${req.end_time},
        department = ${req.department}, notes = ${req.notes}
      WHERE id = ${req.shift_id}
    `;
  } else if (req.action === 'delete') {
    await sql`DELETE FROM shifts WHERE id = ${req.shift_id}`;
  }

  await sql`UPDATE shift_requests SET status = 'approved' WHERE id = ${reqId}`;
  return { ok: true };
}

// ----- shift imports (bulk CSV, admin/manager only) -----

export async function listShiftImports() {
  return sql`SELECT * FROM shift_imports ORDER BY created_at DESC`;
}

export async function createShiftImport({ uploaded_by, filename, row_count }) {
  return row0(await sql`
    INSERT INTO shift_imports (uploaded_by, filename, row_count)
    VALUES (${uploaded_by}, ${filename || null}, ${row_count})
    RETURNING *
  `);
}

// The ON DELETE CASCADE foreign key on shifts.import_id does the actual
// cleanup — this is the "undo this upload" action in the admin UI.
export async function deleteShiftImport(importId) {
  await sql`DELETE FROM shift_imports WHERE id = ${importId}`;
  return true;
}

// ----- time off -----

export async function listTimeOff() {
  return sql`SELECT * FROM time_off_requests ORDER BY created_at DESC`;
}

export async function getTimeOffById(toId) {
  return row0(await sql`SELECT * FROM time_off_requests WHERE id = ${toId}`);
}

export async function createTimeOff({ user_id, start_date, end_date, reason }) {
  return row0(await sql`
    INSERT INTO time_off_requests (user_id, start_date, end_date, reason)
    VALUES (${user_id}, ${start_date}, ${end_date}, ${reason || null})
    RETURNING *
  `);
}

export async function updateTimeOff(toId, updates) {
  const row = await getTimeOffById(toId);
  if (!row) return null;
  const merged = {
    start_date: updates.start_date ?? row.start_date,
    end_date: updates.end_date ?? row.end_date,
    reason: updates.reason !== undefined ? updates.reason : row.reason,
    status: updates.status ?? row.status,
    denial_reason: updates.denial_reason !== undefined ? updates.denial_reason : row.denial_reason,
  };
  return row0(await sql`
    UPDATE time_off_requests SET
      start_date = ${merged.start_date},
      end_date = ${merged.end_date},
      reason = ${merged.reason},
      status = ${merged.status},
      denial_reason = ${merged.denial_reason}
    WHERE id = ${toId}
    RETURNING *
  `);
}

export async function deleteTimeOff(toId) {
  await sql`DELETE FROM time_off_requests WHERE id = ${toId}`;
  return true;
}

// ----- shift swap: posts + claims -----

export async function listSwapPosts() {
  return sql`SELECT * FROM swap_posts ORDER BY created_at DESC`;
}

export async function getSwapPost(postId) {
  return row0(await sql`SELECT * FROM swap_posts WHERE id = ${postId}`);
}

export async function createSwapPost({ shift_id, user_id, reason }) {
  return row0(await sql`
    INSERT INTO swap_posts (shift_id, user_id, reason)
    VALUES (${shift_id}, ${user_id}, ${reason || null})
    RETURNING *
  `);
}

export async function updateSwapPost(postId, updates) {
  const row = await getSwapPost(postId);
  if (!row) return null;
  const status = updates.status ?? row.status;
  return row0(await sql`UPDATE swap_posts SET status = ${status} WHERE id = ${postId} RETURNING *`);
}

export async function listSwapClaims() {
  return sql`SELECT * FROM swap_claims ORDER BY created_at DESC`;
}

export async function getSwapClaim(claimId) {
  return row0(await sql`SELECT * FROM swap_claims WHERE id = ${claimId}`);
}

export async function createSwapClaim({ post_id, claimant_id, offer_shift_id }) {
  return row0(await sql`
    INSERT INTO swap_claims (post_id, claimant_id, offer_shift_id)
    VALUES (${post_id}, ${claimant_id}, ${offer_shift_id || null})
    RETURNING *
  `);
}

export async function updateSwapClaim(claimId, updates) {
  const row = await getSwapClaim(claimId);
  if (!row) return null;
  const status = updates.status ?? row.status;
  return row0(await sql`UPDATE swap_claims SET status = ${status} WHERE id = ${claimId} RETURNING *`);
}

// Not run inside a single DB transaction (the HTTP-based Neon serverless
// driver doesn't support interactive transactions) — acceptable for the
// scale of a single-location staff scheduling tool. Guards on status still
// prevent double-application.
export async function approveSwapClaimTx(claimId) {
  const claim = await getSwapClaim(claimId);
  if (!claim) return { error: 'not_found' };
  if (claim.status !== 'pending') return { error: 'already_resolved', status: claim.status };
  const post = await getSwapPost(claim.post_id);
  if (!post || post.status !== 'open') return { error: 'post_closed' };
  const shift = await getShiftById(post.shift_id);
  if (!shift) return { error: 'shift_missing' };

  await sql`UPDATE shifts SET user_id = ${claim.claimant_id} WHERE id = ${post.shift_id}`;
  if (claim.offer_shift_id) {
    await sql`UPDATE shifts SET user_id = ${post.user_id} WHERE id = ${claim.offer_shift_id}`;
  }
  await sql`UPDATE swap_claims SET status = 'approved' WHERE id = ${claimId}`;
  await sql`UPDATE swap_posts SET status = 'closed' WHERE id = ${post.id}`;
  await sql`
    UPDATE swap_claims SET status = 'denied'
    WHERE post_id = ${post.id} AND id != ${claimId} AND status = 'pending'
  `;
  return { ok: true };
}

// ----- day caps -----

export async function listDayCaps() {
  return sql`SELECT * FROM day_caps ORDER BY date ASC, window_start ASC`;
}

export async function upsertDayCap({ date, window_start, window_end, max_shifts, note }) {
  return row0(await sql`
    INSERT INTO day_caps (date, window_start, window_end, max_shifts, note)
    VALUES (${date}, ${window_start}, ${window_end}, ${max_shifts}, ${note || null})
    ON CONFLICT (date, window_start, window_end)
    DO UPDATE SET max_shifts = EXCLUDED.max_shifts, note = EXCLUDED.note
    RETURNING *
  `);
}

export async function deleteDayCap({ date, window_start, window_end }) {
  await sql`
    DELETE FROM day_caps
    WHERE date = ${date} AND window_start = ${window_start} AND window_end = ${window_end}
  `;
  return true;
}

// ----- API keys (programmatic access, e.g. an AI agent posting a CSV) -----

export async function listApiKeys() {
  return sql`SELECT * FROM api_keys ORDER BY created_at DESC`;
}

export async function findApiKeyByPrefix(prefix) {
  return row0(await sql`SELECT * FROM api_keys WHERE key_prefix = ${prefix} AND revoked = FALSE`);
}

export async function createApiKeyRecord({ label, key_prefix, key_hash, created_by }) {
  return row0(await sql`
    INSERT INTO api_keys (label, key_prefix, key_hash, created_by)
    VALUES (${label}, ${key_prefix}, ${key_hash}, ${created_by})
    RETURNING *
  `);
}

export async function touchApiKey(keyId) {
  await sql`UPDATE api_keys SET last_used_at = now() WHERE id = ${keyId}`;
}

export async function revokeApiKey(keyId) {
  await sql`UPDATE api_keys SET revoked = TRUE WHERE id = ${keyId}`;
  return true;
}

// ----- password reset requests -----

export async function createPasswordResetRequest(userId) {
  return row0(await sql`INSERT INTO password_reset_requests (user_id) VALUES (${userId}) RETURNING *`);
}
export async function listPasswordResetRequests() {
  return sql`SELECT * FROM password_reset_requests ORDER BY requested_at DESC`;
}
export async function resolvePasswordResetRequest(requestId, resolvedBy) {
  return row0(await sql`
    UPDATE password_reset_requests SET resolved_at = now(), resolved_by = ${resolvedBy || null}
    WHERE id = ${requestId} RETURNING *
  `);
}
