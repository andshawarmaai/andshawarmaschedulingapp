// GPS / location check-in was removed in September 2026. Both verbs on
// this endpoint return a clean "feature removed" message so the (now
// hidden) admin form is a no-op. The locations table itself is left
// alone — see CLAUDE.md for why we keep the data and just stop using it.
import db from '../../../lib/db/index.js';
import { isGeofenceConfigured } from '../../../lib/geo.js';

export const prerender = false;

function json(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
}

export async function GET() {
  return json({
    ok: true,
    feature: 'location_geofence_removed',
    message: 'GPS check-in is no longer used.',
    configured: false,
  });
}

export async function PATCH() {
  return json({ error: 'GPS check-in is no longer used — the geofence can\'t be changed.' }, 410);
}

