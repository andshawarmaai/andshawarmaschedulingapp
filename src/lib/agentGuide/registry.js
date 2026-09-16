// The registry of every action an agent (Hermes, or anything else
// authenticating with an API key — see middleware.js's resolveApiKeyUser)
// can safely call against this app. Deliberately hand-maintained code, not
// scraped from route comments — a route's comments are for a human reading
// the source, this is a contract a machine (and CLAUDE.md/AGENT-TRAINING.md)
// both render from the same object, so the two can never drift from each
// other. This file CAN drift from actual route behavior if a route changes
// and this file doesn't — treat updating this file as part of changing any
// route listed below.
//
// `agentMayCall: false` entries are still documented (an agent needs to
// know they exist to understand the workflow) but are marked human-only —
// approving/denying a pending availability request or time-off request, for
// example, is the literal reason the Schedule Builder's review queue
// exists: an admin/manager decides, from that page, on purpose. An agent
// calling it itself — even at a manager's explicit request in
// conversation — defeats the point; surface the pending item and let the
// human do the actual approve/deny in the app.

export const PRINCIPLES = [
  {
    title: 'Approval decisions are human-only',
    body: "Availability requests, time-off requests, and swap claims all land pending and stay that way until a human approves or denies them from the Schedule Builder (or the Time Off / Shift Swap pages). Never call an approve/deny endpoint yourself, even if a manager says 'approve it' in conversation — tell them it's ready for their review and where to find it, or at most confirm you understand what they want before nudging them to actually click it. This is a deliberate design choice (see CLAUDE.md §4), not an oversight.",
  },
  {
    title: 'Direct shift/template writes are immediate — no review queue',
    body: 'Unlike availability, POST /api/shifts, PATCH/DELETE on an existing shift, and all shift_templates writes go live the moment you call them — there is nothing pending to approve afterward. Only call these when you are confident (a clear, specific instruction from an admin/manager), not from an inference about what someone probably meant.',
  },
  {
    title: 'Never invent people, never invent templates',
    body: 'Resolve a name against GET /api/state\'s `users` array (or the bulk-import template\'s roster comment) before referencing a user_id — match on username, exact display name, or first name, and if more than one person shares that first name, ask rather than guessing which one. Do not create a new user account (out of scope for this API entirely — that stays a human, in-app action). Creating a new shift_template changes ongoing weekly coverage rules for everyone; only do it on an explicit, specific instruction, never as a guess at what a schedule "probably" needs.',
  },
  {
    title: 'Idempotency is mostly your responsibility',
    body: 'Almost nothing below has a database-enforced dedup key (day_caps upserts by date+window are the one exception). A retried or resent instruction WILL create a second shift, a second availability entry, or a second swap post if you call the same write twice — track what you\'ve already submitted for a given conversation/message yourself, the API will not catch a duplicate for you. Within /api/public/shift-imports, `cap` rows upsert by (date, window_start, window_end) and `template` rows upsert by exact name, so both are safe to resubmit — `shift` and `swap` rows have no dedup key at all and WILL duplicate on a resubmit.',
  },
  {
    title: 'Authentication',
    body: 'Every call below uses an API key created via POST /api/admin/api-keys (admin session) or the Manage → API Keys card in the UI: header Authorization: Bearer shwrm_xxxxx. The key resolves to the real user who created it and acts with that user\'s exact role and identity — there is no separate "service account" concept, and a write is attributed to that real person just as if they\'d clicked it themselves. A 403 means the key\'s owner does not hold the role a given action requires — create the key from an account with sufficient role rather than trying to escalate.',
  },
];

export const DIRECT_ACTIONS = [
  {
    key: 'state_read',
    label: 'Read current schedule state',
    method: 'GET',
    url: '/api/state',
    minRole: 'staff',
    agentMayCall: true,
    purpose: 'The single aggregate read — users, shifts, shift_requests (availability), time off, shift_templates, day_caps, swap posts/claims, and (staff-or-above) shiftImports/apiKeys, and (admin only) tiers. Call this first to resolve names to ids and see what already exists before writing anything.',
  },
  {
    key: 'availability_create',
    label: "Submit a staff member's availability",
    method: 'POST',
    url: '/api/shift-requests',
    minRole: 'staff',
    agentMayCall: true,
    purpose: "Always submitted as the API key owner (there is no way to submit on behalf of someone else through this endpoint — if you're acting for a specific staff member, the key must belong to that person, or a manager/admin should use shift_create directly instead once they've decided). Use start_time='00:00', end_time='23:59' for \"available all day\" — displayed as \"All day\", not the literal times.",
    idempotency: 'None. Do not resubmit the same availability twice for the same conversation/message.',
    body: [
      { field: 'action', type: '"create"', required: true },
      { field: 'date', type: 'date (YYYY-MM-DD)', required: true },
      { field: 'start_time', type: 'time (HH:MM, 24h)', required: true },
      { field: 'end_time', type: 'time (HH:MM, 24h)', required: true },
      { field: 'notes', type: 'string', required: false },
    ],
    response: '201 with the created shift_request (status: pending, or denied immediately if it exceeds the owner\'s tier limit — see tierLimits.js).',
  },
  {
    key: 'availability_reschedule',
    label: 'Re-propose the date/time on a still-pending availability entry',
    method: 'PATCH',
    url: '/api/shift-requests/{id}  { date?, start_time?, end_time? }  (no "status" field)',
    minRole: 'manager',
    agentMayCall: true,
    purpose: 'The calendar\'s drag-to-move: changes date/time on a request that is still pending — it stays pending either way, nothing is approved by moving it. Send only the fields you\'re changing; omitting "status" entirely is what routes this to reschedule instead of availability_review below.',
    idempotency: 'Not applicable — safe to call again with the same values; only errors if the request is no longer pending.',
    body: [
      { field: 'date', type: 'date (YYYY-MM-DD)', required: false },
      { field: 'start_time', type: 'time (HH:MM)', required: false },
      { field: 'end_time', type: 'time (HH:MM)', required: false },
    ],
    response: '200 with the updated shift_request. 409 if it\'s no longer pending.',
  },
  {
    key: 'availability_review',
    label: 'Approve or deny a pending availability entry',
    method: 'PATCH',
    url: '/api/shift-requests/{id}  { "status": "approved" | "denied", "denial_reason"? }',
    minRole: 'manager',
    agentMayCall: false,
    purpose: 'Human-only — see the "Approval decisions are human-only" principle above. Approving here creates the actual `shifts` row; documented for context, not meant to be called automatically.',
  },
  {
    key: 'availability_cancel',
    label: 'Cancel a pending availability entry',
    method: 'DELETE',
    url: '/api/shift-requests/{id}',
    minRole: 'staff (own, pending only) or manager (any)',
    agentMayCall: true,
    purpose: 'Withdraws a still-pending availability submission. Errors if it has already been approved/denied.',
  },
  {
    key: 'shift_create',
    label: 'Add a shift directly to the schedule',
    method: 'POST',
    url: '/api/shifts',
    minRole: 'manager',
    agentMayCall: true,
    purpose: 'Creates a real, immediately-live scheduled shift — this is the Schedule Builder\'s own write path, not a request that needs later approval. Use this when a manager/admin has already decided who works when; use availability_create instead when a staff member is only reporting when they\'re free.',
    idempotency: 'None — every call creates a new row. Do not call this twice for the same real-world shift.',
    body: [
      { field: 'user_id', type: 'string', required: false, notes: 'Resolve via GET /api/state → users. Omit/null for an unassigned shift.' },
      { field: 'date', type: 'date (YYYY-MM-DD)', required: true },
      { field: 'start_time', type: 'time (HH:MM)', required: true },
      { field: 'end_time', type: 'time (HH:MM)', required: true, notes: 'end_time <= start_time means the shift crosses midnight — do not "correct" it.' },
      { field: 'department', type: '"FOH" | "BOH" | null', required: false },
      { field: 'notes', type: 'string', required: false },
    ],
    response: '201 with the created shift.',
  },
  {
    key: 'shift_update',
    label: 'Move or edit an already-scheduled shift',
    method: 'PATCH',
    url: '/api/shifts/{id}',
    minRole: 'manager',
    agentMayCall: true,
    purpose: "The calendar's drag-to-reschedule for an approved shift, or a direct correction (wrong time, wrong person assigned). Immediate — there is no separate approval step for an existing shift the way there is for a new availability entry.",
    idempotency: 'Not applicable — send only the fields you\'re changing; omitted fields keep their current value.',
    body: [
      { field: 'user_id', type: 'string | null', required: false },
      { field: 'date', type: 'date (YYYY-MM-DD)', required: false },
      { field: 'start_time', type: 'time (HH:MM)', required: false },
      { field: 'end_time', type: 'time (HH:MM)', required: false },
      { field: 'department', type: '"FOH" | "BOH" | null', required: false },
      { field: 'notes', type: 'string', required: false },
    ],
    response: '200 with the updated shift.',
  },
  {
    key: 'shift_delete',
    label: 'Remove a shift from the schedule',
    method: 'DELETE',
    url: '/api/shifts/{id}',
    minRole: 'manager',
    agentMayCall: true,
    purpose: 'Immediate, no undo (short of recreating it) — only call this on an unambiguous, specific instruction ("take Jorge off Tuesday"), never from an inference.',
  },
  {
    key: 'timeoff_create',
    label: "Submit a staff member's time-off request",
    method: 'POST',
    url: '/api/timeoff',
    minRole: 'staff',
    agentMayCall: true,
    purpose: 'Always submitted as the API key owner, same constraint as availability_create. The app\'s own UI shows a non-blocking warning for a start_date within 7 days of today ("may not be approved in time due to staffing constraints") — this endpoint does NOT enforce or return that warning itself, so if you\'re submitting this on someone\'s behalf and the date is close, say so to the human yourself rather than assuming the app will.',
    idempotency: 'None.',
    body: [
      { field: 'start_date', type: 'date (YYYY-MM-DD)', required: true },
      { field: 'end_date', type: 'date (YYYY-MM-DD)', required: true },
      { field: 'reason', type: 'string', required: false },
    ],
    response: '201 with the created time_off_requests row (status: pending, or denied immediately if it exceeds the owner\'s tier limit).',
  },
  {
    key: 'timeoff_edit',
    label: 'Edit the dates/reason on a still-pending time-off request',
    method: 'PATCH',
    url: '/api/timeoff/{id}  { start_date?, end_date?, reason? }  (no "status" field)',
    minRole: 'staff (own, pending only) or manager (any)',
    agentMayCall: true,
    purpose: 'Corrects a still-pending request\'s own dates/reason — distinct from timeoff_review below, which decides it.',
    body: [
      { field: 'start_date', type: 'date (YYYY-MM-DD)', required: false },
      { field: 'end_date', type: 'date (YYYY-MM-DD)', required: false },
      { field: 'reason', type: 'string', required: false },
    ],
    response: '200 with the updated row.',
  },
  {
    key: 'timeoff_review',
    label: 'Approve or deny a pending time-off request',
    method: 'PATCH',
    url: '/api/timeoff/{id}  { "status": "approved" | "denied", "denial_reason"? }',
    minRole: 'manager',
    agentMayCall: false,
    purpose: 'Human-only — see the "Approval decisions are human-only" principle above.',
  },
  {
    key: 'timeoff_cancel',
    label: 'Cancel a time-off request',
    method: 'DELETE',
    url: '/api/timeoff/{id}',
    minRole: 'staff (own) or manager (any)',
    agentMayCall: true,
    purpose: 'Withdraws a request regardless of its current status.',
  },
  {
    key: 'shift_template_create',
    label: 'Create a recurring weekly shift template',
    method: 'POST',
    url: '/api/admin/shift-templates',
    minRole: 'manager',
    agentMayCall: true,
    purpose: "Defines an ongoing coverage block (e.g. \"Opener, 9am-3pm, Mon-Fri\") that every future date's conflict/coverage checks run against. Changes standing policy, not a one-off event — only create one on an explicit, specific instruction.",
    body: [
      { field: 'name', type: 'string', required: true },
      { field: 'days_of_week', type: 'array of 0-6 (Sun=0..Sat=6)', required: true },
      { field: 'start_time', type: 'time (HH:MM)', required: true },
      { field: 'end_time', type: 'time (HH:MM)', required: true, notes: 'end_time <= start_time means it crosses midnight.' },
      { field: 'min_staff', type: 'integer', required: false, notes: 'Drives a non-blocking staffing warning if removing someone would drop below it.' },
      { field: 'max_staff', type: 'integer', required: false, notes: 'Drives the Schedule Builder\'s conflict flag when exceeded.' },
    ],
    response: '201 with the created template.',
  },
  {
    key: 'shift_template_update',
    label: 'Edit a shift template',
    method: 'PATCH',
    url: '/api/admin/shift-templates/{id}',
    minRole: 'manager',
    agentMayCall: true,
    purpose: 'Same fields as shift_template_create — send only what\'s changing.',
  },
  {
    key: 'shift_template_delete',
    label: 'Delete a shift template',
    method: 'DELETE',
    url: '/api/admin/shift-templates/{id}',
    minRole: 'manager',
    agentMayCall: true,
    purpose: 'Removes the recurring coverage rule — existing shifts are untouched, only future conflict/coverage checks stop considering it.',
  },
  {
    key: 'swap_post_create',
    label: 'Post a shift for swap',
    method: 'POST',
    url: '/api/swap/posts',
    minRole: 'staff (own shift only) or manager (any)',
    agentMayCall: true,
    purpose: 'A staff-key caller can only post their own shift; a manager/admin key can post anyone\'s.',
    body: [
      { field: 'shift_id', type: 'string', required: true },
      { field: 'reason', type: 'string', required: false },
    ],
    response: '201 with the created post (status: open).',
  },
  {
    key: 'swap_post_cancel',
    label: 'Cancel/close a swap post',
    method: 'DELETE',
    url: '/api/swap/posts/{id}',
    minRole: 'staff (own) or manager (any)',
    agentMayCall: true,
    purpose: 'Removes an open post from the board.',
  },
  {
    key: 'swap_claim_create',
    label: 'Volunteer for a posted shift',
    method: 'POST',
    url: '/api/swap/claims',
    minRole: 'staff',
    agentMayCall: true,
    purpose: 'Blocked (409) if the slot is already at a day_caps max, or if the same key-owner already has a pending claim on that post.',
    body: [
      { field: 'post_id', type: 'string', required: true },
      { field: 'offer_shift_id', type: 'string', required: false, notes: 'One of the claimant\'s own shifts, offered back to the original poster.' },
    ],
    response: '201 with the created claim (status: pending).',
  },
  {
    key: 'swap_claim_review',
    label: 'Approve or deny a swap claim',
    method: 'PATCH',
    url: '/api/swap/claims/{id}  { "status": "approved" | "denied" }',
    minRole: 'manager',
    agentMayCall: false,
    purpose: 'Human-only — finalizing a swap reassigns the shift between two real people; documented for context, not meant to be called automatically.',
  },
];
