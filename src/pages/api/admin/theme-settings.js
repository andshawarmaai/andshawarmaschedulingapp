// Admin-managed color theme + logo override. Stored in app_settings under
// the 'theme_settings' key as JSON, encrypted by SESSION_SECRET via the
// same AES-256-GCM helper every other secret on the site uses.
//
// The persisted shape (all fields optional):
//   {
//     logo_url:        "https://...",  // absolute https URL or path served by us
//     light: {
//       primary:       "#dc2626",      // brand red — buttons, links, accents
//       primary_dark:  "#b91c1c",      // hover for primary buttons
//       foh:           "#dc2626",      // front-of-house shift color
//       boh:           "#2563eb",      // back-of-house shift color
//       ink:           "#1c1917",      // primary text
//       ink_light:     "#57534e",      // secondary text
//       bg:            "#ffffff",      // page background
//       bg_soft:       "#f5f5f4",      // sidebar / panel header rows
//       border:        "#e7e5e4",      // dividers, input outlines
//       accent:        "#f59e0b",      // chat accent / shift-exception
//       accent_dark:   "#92400e",      // chat gradient deep
//     },
//     dark:  { ...same keys... },
//   }
//
// GET always returns the full object, merging stored values over the
// built-in defaults so a brand-new install (or a half-set row) still
// renders coherently. PATCH accepts a partial — only fields sent are
// persisted; absent fields keep their current value.

import dbCore from '../../../lib/db/index.js';
import { encryptSecret, decryptSecret } from '../../../lib/settingsCrypto.js';

export const prerender = false;

const SETTINGS_KEY = 'theme_settings';

const DEFAULTS = {
  logo_url: null,
  light: {
    primary: '#dc2626',
    primary_dark: '#b91c1c',
    foh: '#dc2626',
    boh: '#2563eb',
    ink: '#1c1917',
    ink_light: '#57534e',
    bg: '#ffffff',
    bg_soft: '#f5f5f4',
    border: '#e7e5e4',
    accent: '#f59e0b',
    accent_dark: '#92400e',
  },
  dark: {
    primary: '#f87171',
    primary_dark: '#ef4444',
    foh: '#f87171',
    boh: '#60a5fa',
    ink: '#f5f5f4',
    ink_light: '#d4d4d8',
    bg: '#0f0f10',
    bg_soft: '#1c1c1f',
    border: '#2e2e33',
    accent: '#fbbf24',
    accent_dark: '#92400e',
  },
};

const HEX_RE = /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;
const LOGO_MAX = 1024;

function json(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
}

function isAdmin(role) {
  return role === 'admin';
}

function sanitizeHex(v) {
  if (typeof v !== 'string') return null;
  const trimmed = v.trim();
  return HEX_RE.test(trimmed) ? trimmed : null;
}

function sanitizeLogo(v) {
  if (v === null || v === '') return null;
  if (typeof v !== 'string') return null;
  // Accept any absolute https URL or a path that starts with /
  if (/^https:\/\//.test(v) || v.startsWith('/')) {
    return v.length <= LOGO_MAX ? v : null;
  }
  return null;
}

// Deep-merge user overrides on top of DEFAULTS so the response always
// has every field a client might read.
function buildTheme(stored) {
  const out = JSON.parse(JSON.stringify(DEFAULTS));
  if (!stored || typeof stored !== 'object') return out;
  if (stored.logo_url === null || typeof stored.logo_url === 'string') {
    out.logo_url = stored.logo_url || null;
  }
  for (const mode of ['light', 'dark']) {
    if (stored[mode] && typeof stored[mode] === 'object') {
      for (const key of Object.keys(out[mode])) {
        const v = stored[mode][key];
        const cleaned = sanitizeHex(v);
        if (cleaned) out[mode][key] = cleaned;
      }
    }
  }
  return out;
}

async function loadStored() {
  const raw = await dbCore.getSetting(SETTINGS_KEY);
  if (!raw) return null;
  try {
    return JSON.parse(decryptSecret(raw));
  } catch (_) {
    return null;
  }
}

export async function GET(context) {
  const me = context.locals.user;
  if (!isAdmin(me.role)) return json({ error: 'Forbidden' }, 403);
  const stored = await loadStored();
  return json({ ok: true, theme: buildTheme(stored), defaults: DEFAULTS });
}

export async function PATCH(context) {
  const me = context.locals.user;
  if (!isAdmin(me.role)) return json({ error: 'Forbidden' }, 403);
  const body = await context.request.json().catch(() => null);
  if (!body || typeof body !== 'object') return json({ error: 'Body must be a JSON object.' }, 400);

  const current = (await loadStored()) || {};
  const next = JSON.parse(JSON.stringify(current));

  if ('logo_url' in body) {
    const cleaned = sanitizeLogo(body.logo_url);
    if (body.logo_url !== null && body.logo_url !== '' && cleaned === null) {
      return json({ error: 'logo_url must be an https:// URL or a /-rooted path, max 1024 chars.' }, 400);
    }
    next.logo_url = cleaned;
  }

  for (const mode of ['light', 'dark']) {
    if (body[mode] && typeof body[mode] === 'object') {
      if (!next[mode]) next[mode] = {};
      for (const [k, v] of Object.entries(body[mode])) {
        const cleaned = sanitizeHex(v);
        if (cleaned === null) {
          return json({ error: `${mode}.${k} must be a #RGB or #RRGGBB hex color.` }, 400);
        }
        next[mode][k] = cleaned;
      }
    }
  }

  const encrypted = encryptSecret(JSON.stringify(next));
  await dbCore.setSetting(SETTINGS_KEY, encrypted, me.id);
  return json({ ok: true, theme: buildTheme(next) });
}

// Used by Layout.astro at render time to inline the theme as CSS variables
// so the very first paint already has the right colors (no flash).
export async function getThemeForRender() {
  return buildTheme(await loadStored());
}
