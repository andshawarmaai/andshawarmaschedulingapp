// The app's real, externally-reachable origin — for anything that leaves
// the current request (a URL shown to a person, a server-to-server fetch
// back into this same app's own API). `context.url.origin` is the origin
// Astro parsed off the incoming request; on Vercel that has been observed
// resolving to "https://localhost" instead of the real deployment host
// (root cause unconfirmed - shows up in generated copy-paste commands as
// "https://localhost/install-relay.sh", curl: (7) can't connect - and,
// more seriously, the same value feeds every server-to-server fetch the
// chat assistant makes back into its own API, silently failing action
// execution and guide-fetching with the identical unreachable-localhost
// error). VERCEL_PROJECT_PRODUCTION_URL is Vercel's own stable production
// domain for this project (never the per-deployment random one, and set
// automatically - no manual config), so it's a source of truth that
// doesn't depend on how the incoming request got parsed. Falls back to
// context.url.origin for local dev, where that env var isn't set.
export function publicOrigin(context) {
  const prod = process.env.VERCEL_PROJECT_PRODUCTION_URL;
  return prod ? `https://${prod}` : context.url.origin;
}
