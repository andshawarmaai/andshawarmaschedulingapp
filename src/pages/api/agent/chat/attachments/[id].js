// GET /api/agent/chat/attachments/[id] — stream an attachment back.
//
// Authorization:
//   - The user who uploaded it (user_id match)
//   - Any admin/manager (so they can see what staff sent in chat)
//   - Anyone in the same thread as the message (parent_id chain) —
//     currently we keep it simple: just uploader + admin/manager.
//   - The server-side agent orchestrator fetching the file on behalf of
//     the user (it does so with the caller's session cookie, so it
//     satisfies the uploader check automatically).
//
// We stream the file from disk so big PDFs / recordings don't bloat
// memory. If the file's gone (tmpfs cold-start eviction, see
// upload.js for context), we return a clean 410 Gone instead of a
// stack trace — the UI's fallback is to show a "file no longer
// available" chip.

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import * as chat from '../../../../../lib/agentChat.js';

export const prerender = false;

function isStaffOrAbove(role) {
  return role === 'admin' || role === 'manager';
}

export async function GET(context) {
  const me = context.locals.user;
  if (!me) return new Response('Unauthorized', { status: 401 });

  const id = context.params.id;
  const att = await chat.getChatAttachment(id);
  if (!att) return new Response('Not found', { status: 404 });

  if (att.user_id !== me.id && !isStaffOrAbove(me.role)) {
    return new Response('Forbidden', { status: 403 });
  }

  // Check the file still exists on disk (Vercel tmpfs may have evicted
  // it on a cold start). Returning 410 is more honest than 404 here —
  // the resource existed, it's just gone.
  let stat;
  try {
    stat = await fsp.stat(att.storage_path);
  } catch (_) {
    return new Response('File no longer available (server storage is ephemeral).', {
      status: 410,
      headers: { 'Content-Type': 'text/plain' },
    });
  }

  // Stream from disk. Node's fs.createReadStream + Web ReadableStream.
  const nodeStream = fs.createReadStream(att.storage_path);
  const webStream = new ReadableStream({
    start(controller) {
      nodeStream.on('data', (chunk) => controller.enqueue(chunk));
      nodeStream.on('end', () => controller.close());
      nodeStream.on('error', (err) => controller.error(err));
    },
    cancel() { nodeStream.destroy(); },
  });

  return new Response(webStream, {
    status: 200,
    headers: {
      'Content-Type': att.mime_type || 'application/octet-stream',
      'Content-Length': String(stat.size),
      'Content-Disposition': `inline; filename="${att.filename.replace(/"/g, '')}"`,
      'Cache-Control': 'private, max-age=3600',
    },
  });
}
