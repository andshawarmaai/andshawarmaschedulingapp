// GPS / location check-in was removed in September 2026. This endpoint
// remains so any stale client call (or a stray script) gets a clean
// "feature not available" message instead of 404 / 500. Real users will
// never reach this path because index.astro's check-in UI is hidden.
import db from '../../lib/db/index.js';
import { checkGeofence } from '../../lib/geo.js';

export const prerender = false;

function json(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
}

export async function POST() {
  return json({ error: 'Location check-in is no longer used.' }, 410);
}

// Kept exported so older imports of these helpers still resolve while
// the rest of the GPS surface is being removed. They are no longer called
// from any active route.
export { checkGeofence };

