// POST /api/admin/theme-settings/logo — accept a logo image upload,
// persist it as a base64 data URL inside the encrypted theme_settings
// blob, and return the new theme.
//
// Storage choice: we don't have a long-lived blob store on Vercel
// (tmpfs is ephemeral, see chat upload.js for that discussion), so
// the only persistent surface we have is the database. Logos are
// small (<100 KB typical, <512 KB enforced), so embedding the base64
// inside the existing encrypted row is fine. The encryption helper
// already accepts arbitrary strings, so this drops in with zero new
// schema work.
//
// Auth: admin only — same as PATCH /api/admin/theme-settings.
//
// Accepted MIME types: png, jpeg, gif, webp, svg. SVG is technically
// allowed but treated as opaque text — we don't sanitize the XML
// inside. The data URL ends up on a single origin in a controlled
// admin context, so this is acceptable for a restaurant-branding
// feature. If we ever embed user-supplied SVG into a public context
// we should add DOMPurify here.

import dbCore from '../../../../lib/db/index.js';
import { encryptSecret, decryptSecret } from '../../../../lib/settingsCrypto.js';
import { buildTheme } from '../theme-settings.js';

export const prerender = false;
export const config = { api: { bodyParser: false } };

const MAX_BYTES = 512 * 1024;  // 512 KB cap on logo file size
const ALLOWED_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/svg+xml']);

function json(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
}

function isAdmin(role) {
  return role === 'admin';
}

export async function POST(context) {
  const me = context.locals.user;
  if (!isAdmin(me.role)) return json({ error: 'Forbidden' }, 403);

  let form;
  try {
    form = await context.request.formData();
  } catch (_) {
    return json({ error: 'Expected multipart/form-data with a "file" field.' }, 400);
  }
  const file = form.get('file');
  if (!file || typeof file === 'string') {
    return json({ error: 'No file uploaded. Send multipart/form-data with field name "file".' }, 400);
  }
  const mime = (file.type || '').toLowerCase();
  if (!ALLOWED_TYPES.has(mime)) {
    return json({ error: `Unsupported image type "${file.type}". Use PNG, JPEG, GIF, WebP, or SVG.` }, 400);
  }
  if (file.size > MAX_BYTES) {
    return json({ error: `Logo too large (${Math.round(file.size / 1024)} KB). Max is ${MAX_BYTES / 1024} KB.` }, 413);
  }

  const buf = Buffer.from(await file.arrayBuffer());
  const dataUrl = `data:${mime};base64,${buf.toString('base64')}`;

  // Merge into the existing theme row so we don't wipe colors.
  const raw = await dbCore.getSetting('theme_settings');
  let current = {};
  if (raw) {
    try { current = JSON.parse(decryptSecret(raw)) || {}; } catch (_) { current = {}; }
  }
  current.logo_data_url = dataUrl;
  // If the caller uploaded, they don't want the prior external URL
  // lingering — but we keep logo_url untouched so admins can swap back
  // by setting logo_url via PATCH. They can also send logo_data_url: null
  // explicitly if they want to wipe the upload entirely.
  const encrypted = encryptSecret(JSON.stringify(current));
  await dbCore.setSetting('theme_settings', encrypted, me.id);

  return json({ ok: true, theme: buildTheme(current) });
}

// DELETE /api/admin/theme-settings/logo — remove an uploaded logo
// (clears logo_data_url). Falls back to logo_url if set, otherwise to
// the default /logo.jpg. Same admin-only auth.
export async function DELETE(context) {
  const me = context.locals.user;
  if (!isAdmin(me.role)) return json({ error: 'Forbidden' }, 403);

  const raw = await dbCore.getSetting('theme_settings');
  if (!raw) return json({ ok: true, theme: buildTheme(null) });
  let current = {};
  try { current = JSON.parse(decryptSecret(raw)) || {}; } catch (_) { current = {}; }
  delete current.logo_data_url;
  const encrypted = encryptSecret(JSON.stringify(current));
  await dbCore.setSetting('theme_settings', encrypted, me.id);
  return json({ ok: true, theme: buildTheme(current) });
}
