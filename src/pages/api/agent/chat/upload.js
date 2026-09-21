// POST /api/agent/chat/upload — accept a multipart file upload, save it
// to the server's local filesystem (/tmp/uploads/), record metadata in
// agent_chat_attachments, return { id, url }.
//
// Storage notes:
//   - Vercel's serverless runtime exposes /tmp as writable tmpfs. Files
//     survive within a single warm instance but are NOT guaranteed across
//     cold starts — if the function that served GET /api/.../attachments/[id]
//     is a different instance from the one that stored the file, you get
//     404. For the scheduling app's use case (the AI reads the file within
//     seconds of upload, then it's done) this is acceptable. If you ever
//     need long-lived attachments, move storage to Cloudflare R2.
//   - We never trust the client-supplied filename — sanitize it. The
//     stored filename is what the user sees; the on-disk name is a UUID.
//
// Auth: same as the rest of /api/agent/chat — any signed-in user can
// upload (staff AND admin). The orchestrator decides what the AI does
// with it based on role.
//
// Max size: 10 MB per file. Cloudflare's free tunnel caps requests at
// 100 MB but we keep ours tighter to avoid blowing tmpfs on the server.

import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import * as chat from '../../../../lib/agentChat.js';

export const prerender = false;
export const config = { api: { bodyParser: false } };

const MAX_BYTES = 10 * 1024 * 1024;          // 10 MB
const UPLOAD_DIR = path.join(os.tmpdir(), 'chat-uploads');

function json(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
}

// Strip any path components and weird chars from a user-supplied filename
// so it can safely be a download Content-Disposition. Falls back to a
// generic name if nothing usable remains.
function sanitizeFilename(name) {
  const base = String(name || 'file').split(/[\\/]/).pop() || 'file';
  const cleaned = base.replace(/[^A-Za-z0-9._-]+/g, '_').slice(0, 120);
  return cleaned || 'file';
}

async function ensureUploadDir() {
  await fs.mkdir(UPLOAD_DIR, { recursive: true });
}

export async function POST(context) {
  const me = context.locals.user;
  if (!me) return json({ error: 'Unauthorized' }, 401);

  let form;
  try {
    form = await context.request.formData();
  } catch (err) {
    return json({ error: 'Expected multipart/form-data with a "file" field.' }, 400);
  }

  const file = form.get('file');
  if (!file || typeof file === 'string') {
    return json({ error: 'No file uploaded. Send multipart/form-data with field name "file".' }, 400);
  }

  if (file.size > MAX_BYTES) {
    return json({ error: `File too large. Max size is ${MAX_BYTES / 1024 / 1024} MB.` }, 413);
  }

  // The chat message this attachment belongs to is optional — if the UI
  // hasn't created the message row yet (upload-before-send pattern), we
  // can either create a placeholder message now or store the attachment
  // orphaned. We do the latter and let the chat POST link it via
  // attachment_ids on the next request. But the UI today is simpler:
  // it uploads the file with message_id=null, then on send posts the
  // message with attachment_ids, and the chat POST updates each
  // attachment's message_id. That keeps the user message + attachments
  // in one DB transaction.
  //
  // For now: store with message_id=null if not provided, and let the
  // sender PATCH it later. message_id is nullable in practice via the
  // ALTER below — but our schema requires it, so we'll create a tiny
  // placeholder message row when none is given. That keeps the FK happy.
  let messageId = form.get('message_id');
  if (messageId && typeof messageId === 'string') {
    const existing = await chat.getChatMessage(messageId);
    if (!existing) return json({ error: 'message_id not found.' }, 400);
    if (existing.user_id !== me.id) return json({ error: 'message_id does not belong to you.' }, 403);
  } else {
    // Create a placeholder user-message row; the real text gets appended
    // on the chat POST via the "attachments linked by id" mechanism.
    const placeholder = await chat.createChatMessage({
      user_id: me.id,
      role: 'user',
      content: '', // empty text — UI shows attachments as the message body
      parent_id: null,
    });
    messageId = placeholder.id;
  }

  await ensureUploadDir();

  const safeName = sanitizeFilename(file.name);
  const id = crypto.randomUUID();
  const onDisk = path.join(UPLOAD_DIR, `${id}__${safeName}`);

  const buf = Buffer.from(await file.arrayBuffer());
  await fs.writeFile(onDisk, buf);

  const row = await chat.createChatAttachment({
    id,
    message_id: messageId,
    user_id: me.id,
    filename: safeName,
    mime_type: file.type || 'application/octet-stream',
    byte_size: buf.length,
    storage_path: onDisk,
  });

  // url is the route the chat panel uses to render <img>/<a download> tags.
  // The fetch endpoint validates that the requesting user owns the
  // attachment OR is admin (so the AI can fetch it via the caller's cookie).
  return json({
    ok: true,
    attachment: {
      id: row.id,
      message_id: row.message_id,
      filename: row.filename,
      mime_type: row.mime_type,
      byte_size: row.byte_size,
      url: `/api/agent/chat/attachments/${row.id}`,
    },
  }, 201);
}
