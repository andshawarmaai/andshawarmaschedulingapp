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
    day_caps: [],
    tiers: [],
    shift_templates: [],
    locations: [],
    jobs: [],
    employee_jobs: [],
    employee_role_profiles: [],
    availability_rules: [],
    template_job_requirements: [],
    schedule_generations: [],
    actual_worked_shifts: [],
    agent_chat_messages: [],
    agent_chat_actions: [],
    app_settings: [],
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
  if (!data.tiers) data.tiers = [];
  if (!data.shift_templates) data.shift_templates = [];
  if (!data.locations) data.locations = [];
  if (!data.jobs) data.jobs = [];
  if (!data.employee_jobs) data.employee_jobs = [];
  if (!data.employee_role_profiles) data.employee_role_profiles = [];
  if (!data.availability_rules) data.availability_rules = [];
  if (!data.template_job_requirements) data.template_job_requirements = [];
  if (!data.schedule_generations) data.schedule_generations = [];
  if (!data.actual_worked_shifts) data.actual_worked_shifts = [];
  if (!data.agent_chat_messages) data.agent_chat_messages = [];
  if (!data.agent_chat_actions) data.agent_chat_actions = [];
  if (!data.app_settings) data.app_settings = [];
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
    tier_id: null,
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
  if (updates.tier_id !== undefined) u.tier_id = updates.tier_id;
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

export async function createShift({ user_id, date, start_time, end_time, department, notes, import_id, job_id }) {
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
    job_id: job_id || null,
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
  // A plain Object.assign would copy over the `undefined` the caller sends
  // for every field it isn't touching (e.g. the calendar's drag-to-move
  // only sends { date }) and wipe the rest — mirrors neon.js's updateShift,
  // which merges field-by-field for the same reason.
  if (updates.user_id !== undefined) s.user_id = updates.user_id;
  if (updates.date !== undefined) s.date = updates.date;
  if (updates.start_time !== undefined) s.start_time = updates.start_time;
  if (updates.end_time !== undefined) s.end_time = updates.end_time;
  if (updates.department !== undefined) s.department = updates.department;
  if (updates.notes !== undefined) s.notes = updates.notes;
  if (updates.job_id !== undefined) s.job_id = updates.job_id;
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

// "Un-commit" an already-scheduled shift back to a pending request —
// dragging it onto the Day view's roster row (admin/schedule.astro's
// wireCoverageInteractions), the reverse of dragging a name IN to fill a
// slot. Deletes the shifts row and creates a brand-new shift_requests row
// with the SAME user/date/time/notes, status 'pending' — this works
// uniformly whether the shift came from an approved request (which stays
// in shift_requests with status 'approved', now just orphaned/stale
// history — nothing reads it) or was added directly by an admin (no
// originating request at all). Bypasses tier-limit checks on purpose:
// this isn't a new commitment being requested, it's an existing one being
// un-done, so it should never be blocked the way a fresh request could be.
export async function revertShiftToPending(shiftId) {
  const d = load();
  const shift = d.shifts.find((s) => s.id === shiftId);
  if (!shift) return null;
  const request = {
    id: id(),
    user_id: shift.user_id,
    action: 'create',
    shift_id: null,
    date: shift.date,
    start_time: shift.start_time,
    end_time: shift.end_time,
    department: shift.department,
    notes: shift.notes,
    status: 'pending',
    denial_reason: null,
    staffing_warning: null,
    created_at: new Date().toISOString(),
  };
  d.shift_requests.push(request);
  d.shifts = d.shifts.filter((s) => s.id !== shiftId);
  d.swap_posts = d.swap_posts.filter((p) => p.shift_id !== shiftId);
  save(d);
  return request;
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

export async function createShiftRequest({ user_id, action, shift_id, date, start_time, end_time, department, notes, status, denial_reason, staffing_warning }) {
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
    status: status || 'pending',
    denial_reason: denial_reason || null,
    staffing_warning: staffing_warning || null,
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

export async function createTimeOff({ user_id, start_date, end_date, reason, status, denial_reason, staffing_warning }) {
  const d = load();
  const row = {
    id: id(),
    user_id,
    start_date,
    end_date,
    reason: reason || null,
    status: status || 'pending',
    denial_reason: denial_reason || null,
    staffing_warning: staffing_warning || null,
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

// ----- tiers (admin-only priority levels — see src/lib/tierLimits.js) -----

export async function listTiers() {
  return load()
    .tiers.slice()
    .sort((a, b) => a.name.localeCompare(b.name));
}

export async function getTierById(tierId) {
  if (!tierId) return null;
  return load().tiers.find((t) => t.id === tierId) || null;
}

export async function createTier({ name, max_shifts_per_month, max_weekend_shifts_per_month, max_days_off_per_month, max_weekend_days_off_per_month, auto_approve_time_off }) {
  const d = load();
  const row = {
    id: id(),
    name,
    max_shifts_per_month: max_shifts_per_month ?? null,
    max_weekend_shifts_per_month: max_weekend_shifts_per_month ?? null,
    max_days_off_per_month: max_days_off_per_month ?? null,
    max_weekend_days_off_per_month: max_weekend_days_off_per_month ?? null,
    auto_approve_time_off: !!auto_approve_time_off,
    created_at: new Date().toISOString(),
  };
  d.tiers.push(row);
  save(d);
  return row;
}

export async function updateTier(tierId, updates) {
  const d = load();
  const row = d.tiers.find((t) => t.id === tierId);
  if (!row) return null;
  if (updates.name !== undefined) row.name = updates.name;
  if (updates.max_shifts_per_month !== undefined) row.max_shifts_per_month = updates.max_shifts_per_month;
  if (updates.max_weekend_shifts_per_month !== undefined) row.max_weekend_shifts_per_month = updates.max_weekend_shifts_per_month;
  if (updates.max_days_off_per_month !== undefined) row.max_days_off_per_month = updates.max_days_off_per_month;
  if (updates.max_weekend_days_off_per_month !== undefined) row.max_weekend_days_off_per_month = updates.max_weekend_days_off_per_month;
  if (updates.auto_approve_time_off !== undefined) row.auto_approve_time_off = !!updates.auto_approve_time_off;
  save(d);
  return row;
}

// Un-assigns the tier from anyone on it (mirrors the Postgres schema's
// ON DELETE SET NULL) before removing it.
export async function deleteTier(tierId) {
  const d = load();
  d.users.forEach((u) => {
    if (u.tier_id === tierId) u.tier_id = null;
  });
  d.tiers = d.tiers.filter((t) => t.id !== tierId);
  save(d);
  return true;
}

// ----- shift templates (recurring coverage blocks — see src/lib/coverage.js) -----

export async function listShiftTemplates() {
  return load()
    .shift_templates.slice()
    .sort((a, b) => a.start_time.localeCompare(b.start_time));
}

export async function getShiftTemplateById(templateId) {
  return load().shift_templates.find((t) => t.id === templateId) || null;
}

export async function createShiftTemplate({ name, days_of_week, start_time, end_time, min_staff, max_staff }) {
  const d = load();
  const row = {
    id: id(),
    name,
    days_of_week,
    start_time,
    end_time,
    min_staff: min_staff ?? null,
    max_staff: max_staff ?? null,
    created_at: new Date().toISOString(),
  };
  d.shift_templates.push(row);
  save(d);
  return row;
}

export async function updateShiftTemplate(templateId, updates) {
  const d = load();
  const row = d.shift_templates.find((t) => t.id === templateId);
  if (!row) return null;
  if (updates.name !== undefined) row.name = updates.name;
  if (updates.days_of_week !== undefined) row.days_of_week = updates.days_of_week;
  if (updates.start_time !== undefined) row.start_time = updates.start_time;
  if (updates.end_time !== undefined) row.end_time = updates.end_time;
  if (updates.min_staff !== undefined) row.min_staff = updates.min_staff;
  if (updates.max_staff !== undefined) row.max_staff = updates.max_staff;
  save(d);
  return row;
}

export async function deleteShiftTemplate(templateId) {
  const d = load();
  d.shift_templates = d.shift_templates.filter((t) => t.id !== templateId);
  save(d);
  return true;
}

// ----- locations (Sprint 1 — multi-location foundation) -----

export async function listLocations() {
  return load()
    .locations.slice()
    .sort((a, b) => a.name.localeCompare(b.name));
}

export async function getLocationById(locationId) {
  if (!locationId) return null;
  return load().locations.find((l) => l.id === locationId) || null;
}

export async function createLocation({ name, timezone, lat, lng, geofence_radius_meters }) {
  const d = load();
  const row = {
    id: id(),
    name,
    timezone: timezone || 'America/New_York',
    disabled: false,
    lat: lat != null ? Number(lat) : null,
    lng: lng != null ? Number(lng) : null,
    geofence_radius_meters: geofence_radius_meters != null ? Number(geofence_radius_meters) : null,
    created_at: new Date().toISOString(),
  };
  d.locations.push(row);
  save(d);
  return row;
}

export async function updateLocation(locationId, updates) {
  const d = load();
  const row = d.locations.find((l) => l.id === locationId);
  if (!row) return null;
  if (updates.name !== undefined) row.name = updates.name;
  if (updates.timezone !== undefined) row.timezone = updates.timezone;
  if (updates.disabled !== undefined) row.disabled = !!updates.disabled;
  if (updates.lat !== undefined) row.lat = updates.lat != null ? Number(updates.lat) : null;
  if (updates.lng !== undefined) row.lng = updates.lng != null ? Number(updates.lng) : null;
  if (updates.geofence_radius_meters !== undefined) row.geofence_radius_meters = updates.geofence_radius_meters != null ? Number(updates.geofence_radius_meters) : null;
  save(d);
  return row;
}

// The single-restaurant default — "a NULL location means the single
// default location until an admin actually splits locations apart" (see
// schema.sql's comment on this table). Used by /api/checkin so a
// check-in doesn't need users.location_id populated, which it usually
// isn't in a single-location deployment.
export async function getPrimaryLocation() {
  const locations = load().locations.filter((l) => !l.disabled);
  if (locations.length === 0) return null;
  return locations.slice().sort((a, b) => a.created_at.localeCompare(b.created_at))[0];
}

// ----- jobs / roles (Sprint 1 — EPIC 2) -----

export async function listJobs() {
  return load()
    .jobs.slice()
    .sort((a, b) => a.name.localeCompare(b.name));
}

export async function getJobById(jobId) {
  if (!jobId) return null;
  return load().jobs.find((j) => j.id === jobId) || null;
}

export async function createJob({ name, department }) {
  const d = load();
  const row = { id: id(), name, department: department || null, disabled: false, created_at: new Date().toISOString() };
  d.jobs.push(row);
  save(d);
  return row;
}

export async function updateJob(jobId, updates) {
  const d = load();
  const row = d.jobs.find((j) => j.id === jobId);
  if (!row) return null;
  if (updates.name !== undefined) row.name = updates.name;
  if (updates.department !== undefined) row.department = updates.department;
  if (updates.disabled !== undefined) row.disabled = !!updates.disabled;
  save(d);
  return row;
}

export async function deleteJob(jobId) {
  const d = load();
  d.jobs = d.jobs.filter((j) => j.id !== jobId);
  d.employee_jobs = d.employee_jobs.filter((ej) => ej.job_id !== jobId);
  d.employee_role_profiles = d.employee_role_profiles.filter((p) => p.job_id !== jobId);
  save(d);
  return true;
}

// ----- employee job qualification (Sprint 1 — EPIC 2) -----
// One row per user+job; re-setting it updates in place (see schema.sql's
// comment on employee_jobs for why this isn't versioned history yet).

export async function listEmployeeJobs({ user_id, job_id } = {}) {
  let rows = load().employee_jobs.slice();
  if (user_id) rows = rows.filter((r) => r.user_id === user_id);
  if (job_id) rows = rows.filter((r) => r.job_id === job_id);
  return rows;
}

export async function setEmployeeJob({ user_id, job_id, qualification_state, effective_date, created_by }) {
  const d = load();
  let row = d.employee_jobs.find((r) => r.user_id === user_id && r.job_id === job_id);
  if (row) {
    row.qualification_state = qualification_state;
    row.effective_date = effective_date;
    row.created_by = created_by ?? row.created_by;
  } else {
    row = {
      id: id(), user_id, job_id, qualification_state, effective_date,
      created_by: created_by || null, created_at: new Date().toISOString(),
    };
    d.employee_jobs.push(row);
  }
  save(d);
  return row;
}

export async function deleteEmployeeJob(user_id, job_id) {
  const d = load();
  d.employee_jobs = d.employee_jobs.filter((r) => !(r.user_id === user_id && r.job_id === job_id));
  d.employee_role_profiles = d.employee_role_profiles.filter((r) => !(r.user_id === user_id && r.job_id === job_id));
  save(d);
  return true;
}

// Removes only the proficiency profile, keeping the employee_jobs
// qualification row intact — used when demoting below 'qualified' rather
// than fully removing the job assignment (see deleteEmployeeJob above).
export async function deleteEmployeeRoleProfile(user_id, job_id) {
  const d = load();
  d.employee_role_profiles = d.employee_role_profiles.filter((r) => !(r.user_id === user_id && r.job_id === job_id));
  save(d);
  return true;
}

// ----- role-specific proficiency (Sprint 1 — EPIC 3) -----

export async function listEmployeeRoleProfiles({ user_id, job_id } = {}) {
  let rows = load().employee_role_profiles.slice();
  if (user_id) rows = rows.filter((r) => r.user_id === user_id);
  if (job_id) rows = rows.filter((r) => r.job_id === job_id);
  return rows;
}

// Only settable for an employee already 'qualified' on this job — enforced
// by the API route, not here, so the enforcement stays in one visible place.
export async function setEmployeeRoleProfile({ user_id, job_id, proficiency, effective_date, source, created_by }) {
  const d = load();
  let row = d.employee_role_profiles.find((r) => r.user_id === user_id && r.job_id === job_id);
  if (row) {
    row.proficiency = proficiency;
    row.effective_date = effective_date;
    row.source = source ?? row.source;
    row.created_by = created_by ?? row.created_by;
  } else {
    row = {
      id: id(), user_id, job_id, proficiency, effective_date,
      source: source || null, created_by: created_by || null, created_at: new Date().toISOString(),
    };
    d.employee_role_profiles.push(row);
  }
  save(d);
  return row;
}

// ----- recurring availability (Sprint 1 — EPIC 4) -----

export async function listAvailabilityRules(userId) {
  const rows = load().availability_rules.slice();
  return userId ? rows.filter((r) => r.user_id === userId) : rows;
}

export async function createAvailabilityRule({ user_id, day_of_week, start_time, end_time, effective_from, effective_to }) {
  const d = load();
  const row = {
    id: id(), user_id, day_of_week, start_time, end_time,
    effective_from: effective_from || null, effective_to: effective_to || null,
    created_at: new Date().toISOString(),
  };
  d.availability_rules.push(row);
  save(d);
  return row;
}

export async function deleteAvailabilityRule(ruleId, userId) {
  const d = load();
  const before = d.availability_rules.length;
  // userId, when given, scopes deletion to that user's own rules — mirrors
  // the ownership check every other self-service delete route already does.
  d.availability_rules = d.availability_rules.filter((r) => !(r.id === ruleId && (!userId || r.user_id === userId)));
  save(d);
  return d.availability_rules.length < before;
}

// ----- peak staffing mix (Sprint 2 — EPIC 3/5, WB-SCH-253) -----

export async function listTemplateJobRequirements(templateId) {
  const rows = load().template_job_requirements || [];
  return templateId ? rows.filter((r) => r.shift_template_id === templateId) : rows.slice();
}

export async function setTemplateJobRequirement({ shift_template_id, job_id, min_count, min_advanced_count, min_proficient_or_better_count }) {
  const d = load();
  if (!d.template_job_requirements) d.template_job_requirements = [];
  let row = d.template_job_requirements.find((r) => r.shift_template_id === shift_template_id && r.job_id === job_id);
  if (row) {
    row.min_count = min_count;
    row.min_advanced_count = min_advanced_count;
    row.min_proficient_or_better_count = min_proficient_or_better_count;
  } else {
    row = {
      id: id(), shift_template_id, job_id, min_count, min_advanced_count, min_proficient_or_better_count,
      created_at: new Date().toISOString(),
    };
    d.template_job_requirements.push(row);
  }
  save(d);
  return row;
}

export async function deleteTemplateJobRequirement(shift_template_id, job_id) {
  const d = load();
  if (!d.template_job_requirements) return true;
  d.template_job_requirements = d.template_job_requirements.filter((r) => !(r.shift_template_id === shift_template_id && r.job_id === job_id));
  save(d);
  return true;
}

// ----- schedule generation snapshots (Sprint 4 — EPIC 7) -----

export async function createScheduleGeneration({ date, generated_by, proposal }) {
  const d = load();
  if (!d.schedule_generations) d.schedule_generations = [];
  const row = {
    id: id(), date, generated_by: generated_by || null, proposal,
    applied_shift_ids: null, applied_by: null, applied_at: null,
    created_at: new Date().toISOString(),
  };
  d.schedule_generations.push(row);
  save(d);
  return row;
}

export async function markScheduleGenerationApplied(generationId, { applied_shift_ids, applied_by }) {
  const d = load();
  const row = (d.schedule_generations || []).find((g) => g.id === generationId);
  if (!row) return null;
  row.applied_shift_ids = applied_shift_ids;
  row.applied_by = applied_by || null;
  row.applied_at = new Date().toISOString();
  save(d);
  return row;
}

export async function listScheduleGenerations({ date } = {}) {
  const rows = (load().schedule_generations || []).slice();
  const filtered = date ? rows.filter((r) => r.date === date) : rows;
  return filtered.sort((a, b) => b.created_at.localeCompare(a.created_at));
}

// ----- actual worked shifts (Sprint 7 — EPIC 11 subset, POS/timeclock-agnostic) -----

export async function findActualWorkedShiftBySourceRef(source, externalRef) {
  if (!externalRef) return null;
  return load().actual_worked_shifts.find((r) => r.source === source && r.external_ref === externalRef) || null;
}

export async function createActualWorkedShift({
  user_id, shift_id, date, clock_in, clock_out, source, external_ref, import_id,
  clock_in_lat, clock_in_lng, clock_in_distance_meters,
}) {
  const d = load();
  const row = {
    id: id(), user_id, shift_id: shift_id || null, date, clock_in, clock_out: clock_out || null,
    source, external_ref: external_ref || null, import_id: import_id || null, created_at: new Date().toISOString(),
    clock_in_lat: clock_in_lat != null ? Number(clock_in_lat) : null,
    clock_in_lng: clock_in_lng != null ? Number(clock_in_lng) : null,
    clock_in_distance_meters: clock_in_distance_meters != null ? Number(clock_in_distance_meters) : null,
    clock_out_lat: null, clock_out_lng: null, clock_out_distance_meters: null,
  };
  d.actual_worked_shifts.push(row);
  save(d);
  return row;
}

// The still-open punch (no clock_out yet) for this user today, if any —
// what /api/checkin's "out" action needs to close, and what the client
// uses to know whether to show "Check In" or "Check Out".
export async function findOpenActualWorkedShift(userId, date) {
  return load().actual_worked_shifts.find((r) => r.user_id === userId && r.date === date && !r.clock_out) || null;
}

export async function closeActualWorkedShift(recordId, { clock_out, clock_out_lat, clock_out_lng, clock_out_distance_meters }) {
  const d = load();
  const row = d.actual_worked_shifts.find((r) => r.id === recordId);
  if (!row) return null;
  row.clock_out = clock_out;
  row.clock_out_lat = clock_out_lat != null ? Number(clock_out_lat) : null;
  row.clock_out_lng = clock_out_lng != null ? Number(clock_out_lng) : null;
  row.clock_out_distance_meters = clock_out_distance_meters != null ? Number(clock_out_distance_meters) : null;
  save(d);
  return row;
}

export async function listActualWorkedShifts({ user_id, date_from, date_to } = {}) {
  let rows = load().actual_worked_shifts.slice();
  if (user_id) rows = rows.filter((r) => r.user_id === user_id);
  if (date_from) rows = rows.filter((r) => r.date >= date_from);
  if (date_to) rows = rows.filter((r) => r.date <= date_to);
  return rows;
}

// ─── Hermes chat ───────────────────────────────────────────────────────────

export async function createChatMessage({ user_id, role, content, parent_id = null }) {
  const d = load();
  const row = {
    id: id(),
    user_id,
    role,
    content,
    status: 'pending',
    parent_id: parent_id || null,
    created_at: new Date().toISOString(),
    completed_at: null,
  };
  d.agent_chat_messages.push(row);
  save(d);
  return row;
}

export async function getChatHistory(user_id, limit = 50) {
  const rows = load().agent_chat_messages
    .filter((m) => m.user_id === user_id)
    .sort((a, b) => a.created_at < b.created_at ? -1 : 1)
    .slice(-limit);
  return rows;
}

export async function getPendingChatMessages(limit = 10) {
  return load().agent_chat_messages
    .filter((m) => m.status === 'pending' && m.role === 'user')
    .sort((a, b) => a.created_at < b.created_at ? -1 : 1)
    .slice(0, limit);
}

export async function updateChatMessageStatus(id, status, content = null) {
  const d = load();
  const row = d.agent_chat_messages.find((m) => m.id === id);
  if (!row) return null;
  row.status = status;
  if (content !== null) row.content = content;
  if (status === 'complete' || status === 'error') row.completed_at = new Date().toISOString();
  save(d);
  return row;
}

export async function getChatMessage(id) {
  return load().agent_chat_messages.find((m) => m.id === id) || null;
}

export async function recordChatAction({ message_id, user_id, method, endpoint, request_body, response_status, response_body, summary }) {
  const d = load();
  const row = {
    id: id(),
    message_id,
    user_id,
    method,
    endpoint,
    request_body: request_body || null,
    response_status: response_status ?? null,
    response_body: response_body || null,
    summary,
    created_at: new Date().toISOString(),
  };
  d.agent_chat_actions.push(row);
  save(d);
  return row;
}

export async function getChatActionsForMessage(message_id) {
  return load().agent_chat_actions.filter((a) => a.message_id === message_id);
}

// ─── App settings (encrypted key/value) ────────────────────────────────────

export async function getSetting(key) {
  return load().app_settings.find((s) => s.key === key) || null;
}

export async function listSettings() {
  return load().app_settings.map((s) => ({ key: s.key, updated_at: s.updated_at, updated_by: s.updated_by }));
}

export async function setSetting(key, encrypted, updated_by) {
  const d = load();
  const i = d.app_settings.findIndex((s) => s.key === key);
  const row = {
    key,
    value_encrypted: encrypted.value_encrypted, // base64 string in local JSON
    iv: encrypted.iv,
    auth_tag: encrypted.auth_tag,
    updated_at: new Date().toISOString(),
    updated_by: updated_by || null,
  };
  if (i >= 0) d.app_settings[i] = row;
  else d.app_settings.push(row);
  save(d);
  return row;
}

export async function deleteSetting(key) {
  const d = load();
  const before = d.app_settings.length;
  d.app_settings = d.app_settings.filter((s) => s.key !== key);
  save(d);
  return d.app_settings.length < before;
}
