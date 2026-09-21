// Astro config — Vercel serverless deployment, Astro 5
import { defineConfig } from 'astro/config';
import vercel from '@astrojs/vercel';

export default defineConfig({
  site: 'https://andshawarmaschedule.vercel.app',
  output: 'server',
  adapter: vercel({
    // Vercel Hobby defaults to 10s — too short for the chat orchestrator's
    // tunnel POST + bridge round-trip + AI provider call. Bump to 60s so
    // the assistant reply can land before Vercel kills the function.
    maxDuration: 60,
  }),
  build: { format: 'directory' },
  // Astro 5's default `security.checkOrigin = true` rejects DELETE/PATCH
  // requests whose Origin header doesn't match Host, which can misfire
  // behind Vercel's proxy. Disabled here because every write is already
  // gated by a signed, httpOnly session cookie + server-side role checks
  // in src/middleware.js — not by browser-origin checks.
  security: {
    checkOrigin: false,
  },
});
