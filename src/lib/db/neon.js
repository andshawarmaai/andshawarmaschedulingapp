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
    // Explicit null (clearing the field) must stick, same reasoning as
    // tier_id below — ?? would fall back to the old value since null is
    // nullish too, which would silently break "clear my phone/email".
    phone: updates.phone !== undefined ? updates.phone : u.phone,
    email: updates.email !== undefined ? updates.email : u.email,
    role: updates.role ?? u.role,
    disabled: updates.disabled ?? u.disabled,
    // Explicit null (un-assigning a tier) must stick — ?? would fall back
    // to the old value since null is nullish too.
    tier_id: updates.tier_id !== undefined ? updates.tier_id : u.tier_id,
    // theme_pref follows the same rule — explicit null/empty clears it,
    // 'light'/'dark' sets it. Constraint enforces valid values at the DB.
    theme_pref: updates.theme_pref !== undefined ? updates.theme_pref : u.theme_pref,
    password_hash: updates.password ? bcrypt.hashSync(updates.password, 10) : u.password_hash,
  };
  // Lazy idempotent migration: production's `users` table predates the
  // theme_pref column this flow relies on.
  try {
    await sql`ALTER TABLE users ADD COLUMN IF NOT EXISTS theme_pref TEXT CHECK (theme_pref IN ('light', 'dark'))`;
  } catch (_) { /* ignore — IF NOT EXISTS in older PG versions throws */ }
  return row0(await sql`
    UPDATE users SET
      display_name = ${merged.display_name},
      phone = ${merged.phone},
      email = ${merged.email},
      role = ${merged.role},
      disabled = ${merged.disabled},
      tier_id = ${merged.tier_id},
      theme_pref = ${merged.theme_pref},
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

export async function createShift({ user_id, date, start_time, end_time, department, notes, import_id, job_id }) {
  return row0(await sql`
    INSERT INTO shifts (user_id, date, start_time, end_time, department, notes, import_id, job_id)
    VALUES (${user_id || null}, ${date}, ${start_time}, ${end_time}, ${department || null}, ${notes || null}, ${import_id || null}, ${job_id || null})
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
    job_id: updates.job_id !== undefined ? updates.job_id : s.job_id,
  };
  return row0(await sql`
    UPDATE shifts SET
      user_id = ${merged.user_id},
      date = ${merged.date},
      start_time = ${merged.start_time},
      end_time = ${merged.end_time},
      department = ${merged.department},
      notes = ${merged.notes},
      job_id = ${merged.job_id}
    WHERE id = ${shiftId}
    RETURNING *
  `);
}

export async function deleteShift(shiftId) {
  await sql`DELETE FROM shifts WHERE id = ${shiftId}`;
  return true;
}

// "Un-commit" an already-scheduled shift back to a pending request — see
// local.js's matching function for the full reasoning (dragging onto the
// Day view's roster row, works uniformly regardless of the shift's
// origin, deliberately bypasses tier limits since nothing new is being
// requested). Mirrors local.js's behavior: insert the new pending
// shift_requests row, then delete the shifts row and any swap post that
// referenced it.
export async function revertShiftToPending(shiftId) {
  const shift = await getShiftById(shiftId);
  if (!shift) return null;
  const request = row0(await sql`
    INSERT INTO shift_requests (user_id, action, shift_id, date, start_time, end_time, department, notes, status, denial_reason, staffing_warning)
    VALUES (${shift.user_id}, 'create', NULL, ${shift.date}, ${shift.start_time}, ${shift.end_time}, ${shift.department}, ${shift.notes}, 'pending', NULL, NULL)
    RETURNING *
  `);
  await sql`DELETE FROM swap_posts WHERE shift_id = ${shiftId}`;
  await sql`DELETE FROM shifts WHERE id = ${shiftId}`;
  return request;
}

// ----- shift requests (staff request -> admin/manager approval) -----

export async function listShiftRequests() {
  return sql`SELECT * FROM shift_requests ORDER BY created_at DESC`;
}

export async function getShiftRequestById(reqId) {
  return row0(await sql`SELECT * FROM shift_requests WHERE id = ${reqId}`);
}

export async function createShiftRequest({ user_id, action, shift_id, date, start_time, end_time, department, notes, status, denial_reason, staffing_warning }) {
  return row0(await sql`
    INSERT INTO shift_requests (user_id, action, shift_id, date, start_time, end_time, department, notes, status, denial_reason, staffing_warning)
    VALUES (${user_id}, ${action}, ${shift_id || null}, ${date || null}, ${start_time || null}, ${end_time || null}, ${department || null}, ${notes || null}, ${status || 'pending'}, ${denial_reason || null}, ${staffing_warning || null})
    RETURNING *
  `);
}

export async function updateShiftRequest(reqId, updates) {
  const row = await getShiftRequestById(reqId);
  if (!row) return null;
  const status = updates.status ?? row.status;
  const denial_reason = updates.denial_reason !== undefined ? updates.denial_reason : row.denial_reason;
  // date/start_time/end_time: the calendar's drag-to-reschedule path for a
  // still-pending request PATCHes just these, with no status — they were
  // missing from this UPDATE entirely, so a drag silently no-op'd here
  // even though it applied fine against local.js's plain Object.assign.
  const date = updates.date ?? row.date;
  const start_time = updates.start_time ?? row.start_time;
  const end_time = updates.end_time ?? row.end_time;
  return row0(await sql`
    UPDATE shift_requests SET status = ${status}, denial_reason = ${denial_reason}, date = ${date}, start_time = ${start_time}, end_time = ${end_time}
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

  // Lazy idempotent migration: production's `shifts` table predates the
  // is_custom column this flow relies on. Without this ALTER, the
  // INSERT below errors. Wrapping in a try/catch + IF NOT EXISTS so
  // it's a no-op on freshly-created databases.
  try {
    await sql`ALTER TABLE shifts ADD COLUMN IF NOT EXISTS is_custom BOOLEAN NOT NULL DEFAULT FALSE`;
  } catch (_) { /* ignore — IF NOT EXISTS in older PG versions throws */ }

  if (req.action === 'create') {
    await sql`
      INSERT INTO shifts (user_id, date, start_time, end_time, department, notes, is_custom)
      VALUES (${req.user_id}, ${req.date}, ${req.start_time}, ${req.end_time}, ${req.department}, ${req.notes}, ${true})
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

export async function createTimeOff({ user_id, start_date, end_date, reason, status, denial_reason, staffing_warning }) {
  return row0(await sql`
    INSERT INTO time_off_requests (user_id, start_date, end_date, reason, status, denial_reason, staffing_warning)
    VALUES (${user_id}, ${start_date}, ${end_date}, ${reason || null}, ${status || 'pending'}, ${denial_reason || null}, ${staffing_warning || null})
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


// ----- tiers (admin-only priority levels — see src/lib/tierLimits.js) -----

export async function listTiers() {
  return sql`SELECT * FROM tiers ORDER BY name ASC`;
}

export async function getTierById(tierId) {
  if (!tierId) return null;
  return row0(await sql`SELECT * FROM tiers WHERE id = ${tierId}`);
}

export async function createTier({ name, max_shifts_per_month, max_weekend_shifts_per_month, max_days_off_per_month, max_weekend_days_off_per_month, auto_approve_time_off }) {
  return row0(await sql`
    INSERT INTO tiers (name, max_shifts_per_month, max_weekend_shifts_per_month, max_days_off_per_month, max_weekend_days_off_per_month, auto_approve_time_off)
    VALUES (${name}, ${max_shifts_per_month ?? null}, ${max_weekend_shifts_per_month ?? null}, ${max_days_off_per_month ?? null}, ${max_weekend_days_off_per_month ?? null}, ${!!auto_approve_time_off})
    RETURNING *
  `);
}

export async function updateTier(tierId, updates) {
  const t = await getTierById(tierId);
  if (!t) return null;
  const merged = {
    name: updates.name ?? t.name,
    max_shifts_per_month: updates.max_shifts_per_month !== undefined ? updates.max_shifts_per_month : t.max_shifts_per_month,
    max_weekend_shifts_per_month: updates.max_weekend_shifts_per_month !== undefined ? updates.max_weekend_shifts_per_month : t.max_weekend_shifts_per_month,
    max_days_off_per_month: updates.max_days_off_per_month !== undefined ? updates.max_days_off_per_month : t.max_days_off_per_month,
    max_weekend_days_off_per_month: updates.max_weekend_days_off_per_month !== undefined ? updates.max_weekend_days_off_per_month : t.max_weekend_days_off_per_month,
    auto_approve_time_off: updates.auto_approve_time_off !== undefined ? !!updates.auto_approve_time_off : t.auto_approve_time_off,
  };
  return row0(await sql`
    UPDATE tiers SET
      name = ${merged.name},
      max_shifts_per_month = ${merged.max_shifts_per_month},
      max_weekend_shifts_per_month = ${merged.max_weekend_shifts_per_month},
      max_days_off_per_month = ${merged.max_days_off_per_month},
      max_weekend_days_off_per_month = ${merged.max_weekend_days_off_per_month},
      auto_approve_time_off = ${merged.auto_approve_time_off}
    WHERE id = ${tierId}
    RETURNING *
  `);
}

export async function deleteTier(tierId) {
  // ON DELETE SET NULL on users.tier_id handles un-assigning automatically.
  await sql`DELETE FROM tiers WHERE id = ${tierId}`;
  return true;
}

// ----- shift templates (recurring coverage blocks — see src/lib/coverage.js) -----

export async function listShiftTemplates() {
  return sql`SELECT * FROM shift_templates ORDER BY start_time ASC`;
}

export async function getShiftTemplateById(templateId) {
  return row0(await sql`SELECT * FROM shift_templates WHERE id = ${templateId}`);
}

export async function createShiftTemplate({ name, days_of_week, start_time, end_time, min_staff, max_staff }) {
  return row0(await sql`
    INSERT INTO shift_templates (name, days_of_week, start_time, end_time, min_staff, max_staff)
    VALUES (${name}, ${days_of_week}, ${start_time}, ${end_time}, ${min_staff ?? null}, ${max_staff ?? null})
    RETURNING *
  `);
}

export async function updateShiftTemplate(templateId, updates) {
  const t = await getShiftTemplateById(templateId);
  if (!t) return null;
  const merged = {
    name: updates.name ?? t.name,
    days_of_week: updates.days_of_week ?? t.days_of_week,
    start_time: updates.start_time ?? t.start_time,
    end_time: updates.end_time ?? t.end_time,
    min_staff: updates.min_staff !== undefined ? updates.min_staff : t.min_staff,
    max_staff: updates.max_staff !== undefined ? updates.max_staff : t.max_staff,
  };
  return row0(await sql`
    UPDATE shift_templates SET
      name = ${merged.name},
      days_of_week = ${merged.days_of_week},
      start_time = ${merged.start_time},
      end_time = ${merged.end_time},
      min_staff = ${merged.min_staff},
      max_staff = ${merged.max_staff}
    WHERE id = ${templateId}
    RETURNING *
  `);
}

export async function deleteShiftTemplate(templateId) {
  await sql`DELETE FROM shift_templates WHERE id = ${templateId}`;
  return true;
}

// ----- locations (Sprint 1 — multi-location foundation) -----

export async function listLocations() {
  return sql`SELECT * FROM locations ORDER BY name ASC`;
}

export async function getLocationById(locationId) {
  if (!locationId) return null;
  return row0(await sql`SELECT * FROM locations WHERE id = ${locationId}`);
}

export async function createLocation({ name, timezone, lat, lng, geofence_radius_meters }) {
  return row0(await sql`
    INSERT INTO locations (name, timezone, lat, lng, geofence_radius_meters)
    VALUES (${name}, ${timezone || 'America/New_York'}, ${lat ?? null}, ${lng ?? null}, ${geofence_radius_meters ?? null})
    RETURNING *
  `);
}

export async function updateLocation(locationId, updates) {
  const l = await getLocationById(locationId);
  if (!l) return null;
  // lat/lng/geofence_radius_meters use `!== undefined` (not `??`) so an
  // explicit null actually clears a previously-set geofence instead of
  // being silently treated as "no change" — the same class of bug
  // CLAUDE.md §4 already documents being fixed for updateUser's
  // phone/email; name/timezone below keep the older `??` pattern since
  // clearing those was never a real case worth handling.
  const merged = {
    name: updates.name ?? l.name,
    timezone: updates.timezone ?? l.timezone,
    disabled: updates.disabled !== undefined ? !!updates.disabled : l.disabled,
    lat: updates.lat !== undefined ? updates.lat : l.lat,
    lng: updates.lng !== undefined ? updates.lng : l.lng,
    geofence_radius_meters: updates.geofence_radius_meters !== undefined ? updates.geofence_radius_meters : l.geofence_radius_meters,
  };
  return row0(await sql`
    UPDATE locations SET name = ${merged.name}, timezone = ${merged.timezone}, disabled = ${merged.disabled},
      lat = ${merged.lat}, lng = ${merged.lng}, geofence_radius_meters = ${merged.geofence_radius_meters}
    WHERE id = ${locationId} RETURNING *
  `);
}

// The single-restaurant default — see the matching comment in local.js.
export async function getPrimaryLocation() {
  return row0(await sql`SELECT * FROM locations WHERE disabled = FALSE ORDER BY created_at ASC LIMIT 1`);
}

// ----- jobs / roles (Sprint 1 — EPIC 2) -----

export async function listJobs() {
  return sql`SELECT * FROM jobs ORDER BY name ASC`;
}

export async function getJobById(jobId) {
  if (!jobId) return null;
  return row0(await sql`SELECT * FROM jobs WHERE id = ${jobId}`);
}

export async function createJob({ name, department }) {
  return row0(await sql`INSERT INTO jobs (name, department) VALUES (${name}, ${department || null}) RETURNING *`);
}

export async function updateJob(jobId, updates) {
  const j = await getJobById(jobId);
  if (!j) return null;
  const merged = {
    name: updates.name ?? j.name,
    department: updates.department !== undefined ? updates.department : j.department,
    disabled: updates.disabled !== undefined ? !!updates.disabled : j.disabled,
  };
  return row0(await sql`
    UPDATE jobs SET name = ${merged.name}, department = ${merged.department}, disabled = ${merged.disabled}
    WHERE id = ${jobId} RETURNING *
  `);
}

export async function deleteJob(jobId) {
  // ON DELETE CASCADE on employee_jobs/employee_role_profiles handles cleanup.
  await sql`DELETE FROM jobs WHERE id = ${jobId}`;
  return true;
}

// ----- employee job qualification (Sprint 1 — EPIC 2) -----

export async function listEmployeeJobs({ user_id, job_id } = {}) {
  if (user_id && job_id) return sql`SELECT * FROM employee_jobs WHERE user_id = ${user_id} AND job_id = ${job_id}`;
  if (user_id) return sql`SELECT * FROM employee_jobs WHERE user_id = ${user_id}`;
  if (job_id) return sql`SELECT * FROM employee_jobs WHERE job_id = ${job_id}`;
  return sql`SELECT * FROM employee_jobs`;
}

export async function setEmployeeJob({ user_id, job_id, qualification_state, effective_date, created_by }) {
  return row0(await sql`
    INSERT INTO employee_jobs (user_id, job_id, qualification_state, effective_date, created_by)
    VALUES (${user_id}, ${job_id}, ${qualification_state}, ${effective_date}, ${created_by || null})
    ON CONFLICT (user_id, job_id) DO UPDATE SET
      qualification_state = EXCLUDED.qualification_state,
      effective_date = EXCLUDED.effective_date,
      created_by = EXCLUDED.created_by
    RETURNING *
  `);
}

export async function deleteEmployeeJob(user_id, job_id) {
  await sql`DELETE FROM employee_jobs WHERE user_id = ${user_id} AND job_id = ${job_id}`;
  await sql`DELETE FROM employee_role_profiles WHERE user_id = ${user_id} AND job_id = ${job_id}`;
  return true;
}

// Removes only the proficiency profile, keeping the employee_jobs
// qualification row intact — used when demoting below 'qualified' rather
// than fully removing the job assignment (see deleteEmployeeJob above).
export async function deleteEmployeeRoleProfile(user_id, job_id) {
  await sql`DELETE FROM employee_role_profiles WHERE user_id = ${user_id} AND job_id = ${job_id}`;
  return true;
}

// ----- role-specific proficiency (Sprint 1 — EPIC 3) -----

export async function listEmployeeRoleProfiles({ user_id, job_id } = {}) {
  if (user_id && job_id) return sql`SELECT * FROM employee_role_profiles WHERE user_id = ${user_id} AND job_id = ${job_id}`;
  if (user_id) return sql`SELECT * FROM employee_role_profiles WHERE user_id = ${user_id}`;
  if (job_id) return sql`SELECT * FROM employee_role_profiles WHERE job_id = ${job_id}`;
  return sql`SELECT * FROM employee_role_profiles`;
}

export async function setEmployeeRoleProfile({ user_id, job_id, proficiency, effective_date, source, created_by }) {
  return row0(await sql`
    INSERT INTO employee_role_profiles (user_id, job_id, proficiency, effective_date, source, created_by)
    VALUES (${user_id}, ${job_id}, ${proficiency}, ${effective_date}, ${source || null}, ${created_by || null})
    ON CONFLICT (user_id, job_id) DO UPDATE SET
      proficiency = EXCLUDED.proficiency,
      effective_date = EXCLUDED.effective_date,
      source = EXCLUDED.source,
      created_by = EXCLUDED.created_by
    RETURNING *
  `);
}

// ----- recurring availability (Sprint 1 — EPIC 4) -----

export async function listAvailabilityRules(userId) {
  if (userId) return sql`SELECT * FROM availability_rules WHERE user_id = ${userId} ORDER BY day_of_week ASC, start_time ASC`;
  return sql`SELECT * FROM availability_rules ORDER BY day_of_week ASC, start_time ASC`;
}

export async function createAvailabilityRule({ user_id, day_of_week, start_time, end_time, effective_from, effective_to }) {
  return row0(await sql`
    INSERT INTO availability_rules (user_id, day_of_week, start_time, end_time, effective_from, effective_to)
    VALUES (${user_id}, ${day_of_week}, ${start_time}, ${end_time}, ${effective_from || null}, ${effective_to || null})
    RETURNING *
  `);
}

export async function deleteAvailabilityRule(ruleId, userId) {
  if (userId) {
    const result = await sql`DELETE FROM availability_rules WHERE id = ${ruleId} AND user_id = ${userId} RETURNING id`;
    return result.length > 0;
  }
  await sql`DELETE FROM availability_rules WHERE id = ${ruleId}`;
  return true;
}

// ----- peak staffing mix (Sprint 2 — EPIC 3/5, WB-SCH-253) -----

export async function listTemplateJobRequirements(templateId) {
  if (templateId) return sql`SELECT * FROM template_job_requirements WHERE shift_template_id = ${templateId}`;
  return sql`SELECT * FROM template_job_requirements`;
}

export async function setTemplateJobRequirement({ shift_template_id, job_id, min_count, min_advanced_count, min_proficient_or_better_count }) {
  return row0(await sql`
    INSERT INTO template_job_requirements (shift_template_id, job_id, min_count, min_advanced_count, min_proficient_or_better_count)
    VALUES (${shift_template_id}, ${job_id}, ${min_count}, ${min_advanced_count}, ${min_proficient_or_better_count})
    ON CONFLICT (shift_template_id, job_id) DO UPDATE SET
      min_count = EXCLUDED.min_count,
      min_advanced_count = EXCLUDED.min_advanced_count,
      min_proficient_or_better_count = EXCLUDED.min_proficient_or_better_count
    RETURNING *
  `);
}

export async function deleteTemplateJobRequirement(shift_template_id, job_id) {
  await sql`DELETE FROM template_job_requirements WHERE shift_template_id = ${shift_template_id} AND job_id = ${job_id}`;
  return true;
}

// ----- schedule generation snapshots (Sprint 4 — EPIC 7) -----

export async function createScheduleGeneration({ date, generated_by, proposal }) {
  return row0(await sql`
    INSERT INTO schedule_generations (date, generated_by, proposal)
    VALUES (${date}, ${generated_by || null}, ${JSON.stringify(proposal)}::jsonb)
    RETURNING *
  `);
}

export async function markScheduleGenerationApplied(generationId, { applied_shift_ids, applied_by }) {
  return row0(await sql`
    UPDATE schedule_generations SET applied_shift_ids = ${applied_shift_ids}, applied_by = ${applied_by || null}, applied_at = now()
    WHERE id = ${generationId}
    RETURNING *
  `);
}

export async function listScheduleGenerations({ date } = {}) {
  if (date) return sql`SELECT * FROM schedule_generations WHERE date = ${date} ORDER BY created_at DESC`;
  return sql`SELECT * FROM schedule_generations ORDER BY created_at DESC`;
}

// ----- actual worked shifts (Sprint 7 — EPIC 11 subset, POS/timeclock-agnostic) -----

export async function findActualWorkedShiftBySourceRef(source, externalRef) {
  if (!externalRef) return null;
  return row0(await sql`SELECT * FROM actual_worked_shifts WHERE source = ${source} AND external_ref = ${externalRef}`);
}

export async function createActualWorkedShift({
  user_id, shift_id, date, clock_in, clock_out, source, external_ref, import_id,
  clock_in_lat, clock_in_lng, clock_in_distance_meters,
}) {
  return row0(await sql`
    INSERT INTO actual_worked_shifts (user_id, shift_id, date, clock_in, clock_out, source, external_ref, import_id, clock_in_lat, clock_in_lng, clock_in_distance_meters)
    VALUES (${user_id}, ${shift_id || null}, ${date}, ${clock_in}, ${clock_out || null}, ${source}, ${external_ref || null}, ${import_id || null}, ${clock_in_lat ?? null}, ${clock_in_lng ?? null}, ${clock_in_distance_meters ?? null})
    RETURNING *
  `);
}

// The still-open punch (no clock_out yet) for this user today, if any —
// see the matching comment in local.js.
export async function findOpenActualWorkedShift(userId, date) {
  return row0(await sql`SELECT * FROM actual_worked_shifts WHERE user_id = ${userId} AND date = ${date} AND clock_out IS NULL`);
}

export async function closeActualWorkedShift(recordId, { clock_out, clock_out_lat, clock_out_lng, clock_out_distance_meters }) {
  return row0(await sql`
    UPDATE actual_worked_shifts
    SET clock_out = ${clock_out}, clock_out_lat = ${clock_out_lat ?? null}, clock_out_lng = ${clock_out_lng ?? null}, clock_out_distance_meters = ${clock_out_distance_meters ?? null}
    WHERE id = ${recordId} RETURNING *
  `);
}

export async function listActualWorkedShifts({ user_id, date_from, date_to } = {}) {
  if (user_id && date_from && date_to) return sql`SELECT * FROM actual_worked_shifts WHERE user_id = ${user_id} AND date >= ${date_from} AND date <= ${date_to}`;
  if (user_id) return sql`SELECT * FROM actual_worked_shifts WHERE user_id = ${user_id}`;
  if (date_from && date_to) return sql`SELECT * FROM actual_worked_shifts WHERE date >= ${date_from} AND date <= ${date_to}`;
  return sql`SELECT * FROM actual_worked_shifts`;
}

// ─── Hermes chat ───────────────────────────────────────────────────────────

export async function createChatMessage({ user_id, role, content, parent_id = null }) {
  return row0(await sql`
    INSERT INTO agent_chat_messages (user_id, role, content, parent_id)
    VALUES (${user_id}, ${role}, ${content}, ${parent_id})
    RETURNING *
  `);
}

export async function getChatHistory(user_id, limit = 50) {
  const rows = await sql`
    SELECT * FROM agent_chat_messages
    WHERE user_id = ${user_id}
    ORDER BY created_at DESC
    LIMIT ${limit}
  `;
  return rows.reverse();
}

export async function getPendingChatMessages(limit = 10) {
  return sql`
    SELECT m.*, u.username, u.role AS user_role, u.display_name
    FROM agent_chat_messages m
    JOIN users u ON u.id = m.user_id
    WHERE m.status = 'pending' AND m.role = 'user'
    ORDER BY m.created_at ASC
    LIMIT ${limit}
  `;
}

export async function updateChatMessageStatus(id, status, content = null) {
  if (content !== null) {
    return row0(await sql`
      UPDATE agent_chat_messages
      SET status = ${status}, content = ${content}, completed_at = CASE WHEN ${status} IN ('complete','error') THEN now() ELSE completed_at END
      WHERE id = ${id} RETURNING *
    `);
  }
  return row0(await sql`
    UPDATE agent_chat_messages
    SET status = ${status}, completed_at = CASE WHEN ${status} IN ('complete','error') THEN now() ELSE completed_at END
    WHERE id = ${id} RETURNING *
  `);
}

export async function getChatMessage(id) {
  return row0(await sql`SELECT * FROM agent_chat_messages WHERE id = ${id}`);
}

export async function recordChatAction({ message_id, user_id, method, endpoint, request_body, response_status, response_body, summary }) {
  return row0(await sql`
    INSERT INTO agent_chat_actions (message_id, user_id, method, endpoint, request_body, response_status, response_body, summary)
    VALUES (${message_id}, ${user_id}, ${method}, ${endpoint}, ${JSON.stringify(request_body || null)}::jsonb, ${response_status ?? null}, ${JSON.stringify(response_body || null)}::jsonb, ${summary})
    RETURNING *
  `);
}

export async function getChatActionsForMessage(message_id) {
  return sql`SELECT * FROM agent_chat_actions WHERE message_id = ${message_id} ORDER BY created_at ASC`;
}

// ─── Chat attachments ───────────────────────────────────────────────────────
// Files uploaded into chat. The orchestrator and the chat UI both call into
// these — the UI to render thumbnails/file chips for each message, the
// orchestrator to know what file paths to put in the agent payload.

export async function createChatAttachment({ id, message_id, user_id, filename, mime_type, byte_size, storage_path }) {
  return row0(await sql`
    INSERT INTO agent_chat_attachments (id, message_id, user_id, filename, mime_type, byte_size, storage_path)
    VALUES (${id}, ${message_id}, ${user_id}, ${filename}, ${mime_type}, ${byte_size}, ${storage_path})
    RETURNING *
  `);
}

export async function getChatAttachmentsForMessage(message_id) {
  return sql`SELECT * FROM agent_chat_attachments WHERE message_id = ${message_id} ORDER BY created_at ASC`;
}

export async function getChatAttachmentsForMessages(message_ids) {
  if (!message_ids || message_ids.length === 0) return [];
  return sql`SELECT * FROM agent_chat_attachments WHERE message_id = ANY(${message_ids}) ORDER BY created_at ASC`;
}

export async function getChatAttachment(id) {
  return row0(await sql`SELECT * FROM agent_chat_attachments WHERE id = ${id}`);
}

export async function deleteChatAttachment(id) {
  await sql`DELETE FROM agent_chat_attachments WHERE id = ${id}`;
}

// Wipe ALL chat history for a single user. We DELETE the related rows
// explicitly rather than relying on a CASCADE because the
// agent_chat_actions.message_id FK was never declared ON DELETE CASCADE
// (the CASCADE on agent_chat_attachments.message_id is the only one in
// the schema). Called from /api/auth/login and /api/auth/logout so the
// chat panel starts fresh on every session and the DB doesn't fill up
// with stale conversation rows.
export async function clearChatForUser(user_id) {
  // Snapshot the user's message ids, then wipe everything that points at
  // them (actions + attachments), then the messages themselves.
  const messageRows = await sql`SELECT id FROM agent_chat_messages WHERE user_id = ${user_id}`;
  const ids = messageRows.map((r) => r.id);
  if (ids.length === 0) return 0;
  await sql`DELETE FROM agent_chat_actions WHERE message_id = ANY(${ids})`;
  await sql`DELETE FROM agent_chat_attachments WHERE message_id = ANY(${ids})`;
  const result = await sql`DELETE FROM agent_chat_messages WHERE id = ANY(${ids}) RETURNING id`;
  return result.length;
}


// Lazy self-healing: the chat_security_log table is created on first
// use if it doesn't already exist. Cheaper than a manual migration step
// (db/apply-schema.mjs), and survives both fresh DBs and ones that
// already have the table from a prior schema run. Module-level flag
// means we only attempt this once per server lifetime — never on the
// hot path.
let _chatSecuritySchemaEnsured = false;
async function ensureChatSecuritySchema() {
  if (_chatSecuritySchemaEnsured) return;
  await sql`
    CREATE TABLE IF NOT EXISTS chat_security_log (
      id              TEXT PRIMARY KEY,
      user_id         TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      kind            TEXT NOT NULL,
      message_excerpt TEXT NOT NULL,
      agent_reply     TEXT NOT NULL,
      created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `;
  await sql`CREATE INDEX IF NOT EXISTS idx_chat_security_log_user ON chat_security_log(user_id)`;
  await sql`CREATE INDEX IF NOT EXISTS idx_chat_security_log_created ON chat_security_log(created_at DESC)`;
  _chatSecuritySchemaEnsured = true;
}

// ─── Chat security log ────────────────────────────────────────────────────
// Every suspicious / off-topic / prompt-injection event in the chat is
// recorded here for admin review. Admin/manager can list recent events
// via /api/admin/agent-chat/security.
export async function createChatSecurityEvent({ user_id, kind, message_excerpt, agent_reply, request_id }) {
  await ensureChatSecuritySchema();
  const id = request_id || crypto.randomUUID();
  await sql`
    INSERT INTO chat_security_log (id, user_id, kind, message_excerpt, agent_reply, created_at)
    VALUES (${id}, ${user_id}, ${kind},
            ${(message_excerpt || '').slice(0, 500)},
            ${(agent_reply || '').slice(0, 500)},
            now())
  `;
  return { id, user_id, kind, message_excerpt, agent_reply };
}

export async function listChatSecurityEvents({ limit = 200 } = {}) {
  await ensureChatSecuritySchema();
  return sql`
    SELECT id, user_id, kind, message_excerpt, agent_reply, created_at
    FROM chat_security_log
    ORDER BY created_at DESC
    LIMIT ${Math.min(Math.max(Number(limit) || 200, 1), 1000)}
  `;
}

// ─── App settings (encrypted key/value) ────────────────────────────────────

export async function getSetting(key) {
  return row0(await sql`SELECT * FROM app_settings WHERE key = ${key}`);
}

export async function listSettings() {
  // Returns metadata only — never the encrypted value bytes.
  const rows = await sql`SELECT key, updated_at, updated_by FROM app_settings ORDER BY key`;
  return rows;
}

export async function setSetting(key, encrypted, updated_by) {
  const existing = await getSetting(key);
  if (existing) {
    return row0(await sql`
      UPDATE app_settings
      SET value_encrypted = ${encrypted.value_encrypted},
          iv = ${encrypted.iv},
          auth_tag = ${encrypted.auth_tag},
          updated_at = now(),
          updated_by = ${updated_by || null}
      WHERE key = ${key} RETURNING *
    `);
  }
  return row0(await sql`
    INSERT INTO app_settings (key, value_encrypted, iv, auth_tag, updated_by)
    VALUES (${key}, ${encrypted.value_encrypted}, ${encrypted.iv}, ${encrypted.auth_tag}, ${updated_by || null})
    RETURNING *
  `);
}

export async function deleteSetting(key) {
  const r = await sql`DELETE FROM app_settings WHERE key = ${key}`;
  return r.length > 0;
}

// ─── Schedule assistant chat ───────────────────────────────────────────────
// One thread per person. A user message waits as 'pending' until the
// restaurant's Hermes (relay) or cloud AI answers; `prompt` holds the fully
// built prompt the relay hands to Hermes. Attachments/files are small and
// stored inline (base64) so nothing depends on a server's disk.
let assistantSchemaReady = null;
function ensureAssistantSchema() {
  assistantSchemaReady ??= (async () => {
    await sql`
      CREATE TABLE IF NOT EXISTS assistant_messages (
        id          TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
        user_id     TEXT NOT NULL,
        role        TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
        body        TEXT NOT NULL DEFAULT '',
        status      TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'answered', 'failed')),
        prompt      TEXT,
        attachments JSONB NOT NULL DEFAULT '[]'::jsonb,
        actions     JSONB NOT NULL DEFAULT '[]'::jsonb,
        reply_to    TEXT,
        created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
      )`;
    await sql`CREATE INDEX IF NOT EXISTS assistant_messages_user_idx ON assistant_messages (user_id, created_at)`;
    await sql`CREATE INDEX IF NOT EXISTS assistant_messages_pending_idx ON assistant_messages (status) WHERE role = 'user'`;
    await sql`
      CREATE TABLE IF NOT EXISTS setup_codes (
        code_hash  TEXT PRIMARY KEY,
        sealed_key TEXT NOT NULL,
        created_by TEXT,
        expires_at TIMESTAMPTZ NOT NULL,
        used_at    TIMESTAMPTZ
      )`;
  })().catch((err) => { assistantSchemaReady = null; throw err; });
  return assistantSchemaReady;
}
export async function createAssistantMessage({ user_id, role, body = '', status = 'pending', prompt = null, attachments = [], actions = [], reply_to = null }) {
  await ensureAssistantSchema();
  return row0(await sql`
    INSERT INTO assistant_messages (user_id, role, body, status, prompt, attachments, actions, reply_to)
    VALUES (${user_id}, ${role}, ${body}, ${status}, ${prompt}, ${JSON.stringify(attachments)}, ${JSON.stringify(actions)}, ${reply_to})
    RETURNING *`);
}
export async function listAssistantMessages(user_id, limit = 60) {
  await ensureAssistantSchema();
  const rows = await sql`SELECT * FROM assistant_messages WHERE user_id = ${user_id} ORDER BY created_at DESC LIMIT ${limit}`;
  return rows.reverse();
}
export async function getAssistantMessage(id) {
  await ensureAssistantSchema();
  return row0(await sql`SELECT * FROM assistant_messages WHERE id = ${id}`);
}
export async function listPendingAssistantPrompts(limit = 10) {
  await ensureAssistantSchema();
  return sql`
    SELECT * FROM assistant_messages
    WHERE role = 'user' AND status = 'pending' AND prompt IS NOT NULL
    ORDER BY created_at ASC LIMIT ${limit}`;
}
export async function updateAssistantMessage(id, { status, prompt }) {
  await ensureAssistantSchema();
  if (prompt !== undefined) return row0(await sql`UPDATE assistant_messages SET status = COALESCE(${status ?? null}, status), prompt = ${prompt} WHERE id = ${id} RETURNING *`);
  return row0(await sql`UPDATE assistant_messages SET status = ${status} WHERE id = ${id} RETURNING *`);
}
export async function clearAssistantMessages(user_id) {
  await ensureAssistantSchema();
  await sql`DELETE FROM assistant_messages WHERE user_id = ${user_id}`;
}
export async function createSetupCode({ code_hash, sealed_key, created_by, expires_at }) {
  await ensureAssistantSchema();
  await sql`INSERT INTO setup_codes (code_hash, sealed_key, created_by, expires_at) VALUES (${code_hash}, ${sealed_key}, ${created_by}, ${expires_at})`;
}
export async function claimSetupCode(code_hash) {
  await ensureAssistantSchema();
  return row0(await sql`
    UPDATE setup_codes SET used_at = now()
    WHERE code_hash = ${code_hash} AND used_at IS NULL AND expires_at > now()
    RETURNING sealed_key`);
}
