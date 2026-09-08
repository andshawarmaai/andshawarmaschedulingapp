// Picks the storage backend: real Neon Postgres once DATABASE_URL is set,
// otherwise a local JSON file so the app is fully runnable (and testable)
// before it's wired up to Neon. Every route imports from here, never from
// local.js / neon.js directly, so swapping backends is a one-line change.

import * as neonDb from './neon.js';
import * as localDb from './local.js';

const backend = process.env.DATABASE_URL ? neonDb : localDb;

export default backend;
export const usingLocalDb = !process.env.DATABASE_URL;
