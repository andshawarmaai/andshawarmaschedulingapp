// Not under an ADMIN_ONLY_PREFIX — any signed-in user (staff included) can
// reach this, same as /api/me.js. Deliberately NOT registered in
// agentGuide/registry.js and never should be: this proves a real person's
// phone was physically at the restaurant at this moment, so an agent
// calling it on someone's behalf (with fabricated or even honestly-
// relayed coordinates) defeats the entire point of the feature. This is
// a human-only action, the same way HERMES-SOCIAL-MEDIA.md's publish
// endpoint is human-only in the sibling app.
import db from '../../lib/db/index.js';
import { checkGeofence } from '../../lib/geo.js';

export const prerender = false;

function json(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
}

function isValidCoord(lat, lng) {
  return typeof lat === 'number' && typeof lng === 'number'
    && !Number.isNaN(lat) && !Number.isNaN(lng)
    && lat >= -90 && lat <= 90 && lng >= -180 && lng <= 180;
}

export async function POST(context) {
  const me = context.locals.user;
  const body = await context.request.json().catch(() => null);
  if (!body) return json({ error: 'Invalid request body.' }, 400);

  const action = body.action === 'out' ? 'out' : 'in';
  const lat = Number(body.lat);
  const lng = Number(body.lng);
  if (!isValidCoord(lat, lng)) return json({ error: 'A valid GPS location is required to check in or out.' }, 400);

  // date/time come from the caller's own device, not the server — this
  // app has no existing server-side business-timezone conversion (every
  // other date/time in this codebase is entered directly in local terms
  // by a human; see CLAUDE.md §3), and the person checking in is, by
  // definition, physically at the business right now, so their phone's
  // own clock already reads the correct local time.
  const date = typeof body.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(body.date) ? body.date : null;
  const time = typeof body.time === 'string' && /^\d{2}:\d{2}$/.test(body.time) ? body.time : null;
  if (!date || !time) return json({ error: 'date (YYYY-MM-DD) and time (HH:MM) are required.' }, 400);

  const location = await db.getPrimaryLocation();
  const geofence = checkGeofence(lat, lng, location);
  if (geofence.reason === 'not_configured') {
    return json({ error: 'Check-in location has not been set up yet — ask an admin to set it in Manage → Location Check-In.' }, 409);
  }
  if (!geofence.ok) {
    return json({
      error: `You're too far from the restaurant to check ${action === 'in' ? 'in' : 'out'} (about ${Math.round(geofence.distanceMeters)}m away, needs to be within ${location.geofence_radius_meters}m).`,
    }, 403);
  }

  if (action === 'in') {
    const existing = await db.findOpenActualWorkedShift(me.id, date);
    if (existing) return json({ error: `Already checked in since ${existing.clock_in}.` }, 409);
    const record = await db.createActualWorkedShift({
      user_id: me.id, date, clock_in: time, source: 'self_checkin',
      clock_in_lat: lat, clock_in_lng: lng, clock_in_distance_meters: geofence.distanceMeters,
    });
    return json({ ok: true, record });
  }

  const open = await db.findOpenActualWorkedShift(me.id, date);
  if (!open) return json({ error: 'Not checked in — nothing to check out of.' }, 409);
  const record = await db.closeActualWorkedShift(open.id, {
    clock_out: time, clock_out_lat: lat, clock_out_lng: lng, clock_out_distance_meters: geofence.distanceMeters,
  });
  return json({ ok: true, record });
}
