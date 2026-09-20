// GPS-verified self check-in — distance math only, no I/O. Kept pure and
// separate from the API route so it's trivially unit-testable and never
// tempted to reach into db/session concerns.
const EARTH_RADIUS_METERS = 6371000;

function toRadians(deg) {
  return (deg * Math.PI) / 180;
}

// Haversine great-circle distance — accurate enough at restaurant-parking-
// lot scale (the flat-earth approximation error only matters at hundreds
// of kilometers, nowhere near a geofence radius here).
export function distanceMeters(lat1, lng1, lat2, lng2) {
  const dLat = toRadians(lat2 - lat1);
  const dLng = toRadians(lng2 - lng1);
  const a = Math.sin(dLat / 2) ** 2
    + Math.cos(toRadians(lat1)) * Math.cos(toRadians(lat2)) * Math.sin(dLng / 2) ** 2;
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return EARTH_RADIUS_METERS * c;
}

// A location with no lat/lng/radius set is "not configured yet," not "zero
// distance always passes" — checked explicitly so a half-configured
// location fails closed (reject check-in with a clear reason) instead of
// silently allowing everyone through.
export function isGeofenceConfigured(location) {
  return !!location && location.lat != null && location.lng != null && location.geofence_radius_meters != null;
}

export function checkGeofence(lat, lng, location) {
  if (!isGeofenceConfigured(location)) {
    return { ok: false, reason: 'not_configured', distanceMeters: null };
  }
  const distance = distanceMeters(lat, lng, location.lat, location.lng);
  return { ok: distance <= location.geofence_radius_meters, reason: null, distanceMeters: distance };
}
