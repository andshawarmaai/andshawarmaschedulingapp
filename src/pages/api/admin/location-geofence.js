// Gated to admin/manager by middleware.js (ADMIN_ONLY_PREFIXES covers /api/admin).
// A single-restaurant simplification of the multi-location `locations`
// table: this always reads/writes the one "primary" location (the oldest
// non-disabled row — see db.getPrimaryLocation), creating it on first
// save if none exists yet. If this app ever actually splits into real
// multiple locations, this route is the one to generalize with a
// location_id param — not before, since nothing today needs that.
import db from '../../../lib/db/index.js';
import { isGeofenceConfigured } from '../../../lib/geo.js';

export const prerender = false;

function json(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
}

export async function GET() {
  const location = await db.getPrimaryLocation();
  return json({
    ok: true,
    location,
    configured: isGeofenceConfigured(location),
  });
}

export async function PATCH(context) {
  const body = await context.request.json().catch(() => null);
  if (!body) return json({ error: 'Invalid request body.' }, 400);

  const lat = body.lat === null ? null : Number(body.lat);
  const lng = body.lng === null ? null : Number(body.lng);
  const radius = body.geofence_radius_meters === null ? null : Number(body.geofence_radius_meters);
  if (lat !== null && (Number.isNaN(lat) || lat < -90 || lat > 90)) return json({ error: 'lat must be between -90 and 90.' }, 400);
  if (lng !== null && (Number.isNaN(lng) || lng < -180 || lng > 180)) return json({ error: 'lng must be between -180 and 180.' }, 400);
  if (radius !== null && (Number.isNaN(radius) || radius < 0)) return json({ error: 'geofence_radius_meters must be 0 or higher.' }, 400);

  let location = await db.getPrimaryLocation();
  if (!location) {
    location = await db.createLocation({
      name: body.name ? String(body.name).trim() : 'Main Location',
      lat, lng, geofence_radius_meters: radius,
    });
  } else {
    location = await db.updateLocation(location.id, { lat, lng, geofence_radius_meters: radius });
  }
  return json({ ok: true, location, configured: isGeofenceConfigured(location) });
}
