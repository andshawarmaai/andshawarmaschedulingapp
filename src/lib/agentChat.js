// Hermes chat data layer. Same dual-backend pattern as src/lib/db/* — every
// function here is implemented in both neon.js and local.js with identical
// signatures, so the rest of the app never knows which backend is in use.
//
// agent_chat_messages holds every chat turn (user message + assistant reply
// pair, plus optional nested corrections via parent_id). agent_chat_actions
// holds every API call the agent made while fulfilling the user's request,
// so the chat UI can show "✓ Scheduled Jorge Friday 11-7pm (shift_id abc)"
// instead of just "Done."

import dbCore from './db/index.js';

// ─── Messages ──────────────────────────────────────────────────────────────

export async function createChatMessage({ user_id, role, content, parent_id = null }) {
  return dbCore.createChatMessage({ user_id, role, content, parent_id });
}

export async function getChatHistory(user_id, limit = 50) {
  return dbCore.getChatHistory(user_id, limit);
}

// Pending = user typed a message and is waiting for the agent. The agent
// polls for these.
export async function getPendingChatMessages(limit = 10) {
  return dbCore.getPendingChatMessages(limit);
}

// Mark an assistant reply as it's being streamed ('streaming') and again
// when it's done ('complete') or failed ('error'). The chat UI's SSE polls
// for status changes on its own most-recent assistant row.
export async function updateChatMessageStatus(id, status, content = null) {
  return dbCore.updateChatMessageStatus(id, status, content);
}

export async function getChatMessage(id) {
  return dbCore.getChatMessage(id);
}

// ─── Actions (audit log) ───────────────────────────────────────────────────

export async function recordChatAction({ message_id, user_id, method, endpoint, request_body, response_status, response_body, summary }) {
  return dbCore.recordChatAction({ message_id, user_id, method, endpoint, request_body, response_status, response_body, summary });
}

export async function getChatActionsForMessage(message_id) {
  return dbCore.getChatActionsForMessage(message_id);
}

// ─── Attachments ────────────────────────────────────────────────────────────
// Files uploaded into chat (photos, PDFs, audio, etc.). See
// src/pages/api/agent/chat/upload.js for the upload endpoint and
// src/pages/api/agent/chat/attachments/[id].js for the serve endpoint.

export async function createChatAttachment({ id, message_id, user_id, filename, mime_type, byte_size, storage_path }) {
  return dbCore.createChatAttachment({ id, message_id, user_id, filename, mime_type, byte_size, storage_path });
}

export async function getChatAttachmentsForMessage(message_id) {
  return dbCore.getChatAttachmentsForMessage(message_id);
}

export async function getChatAttachmentsForMessages(message_ids) {
  return dbCore.getChatAttachmentsForMessages(message_ids);
}

export async function getChatAttachment(id) {
  return dbCore.getChatAttachment(id);
}

export async function deleteChatAttachment(id) {
  return dbCore.deleteChatAttachment(id);
}


// Wipe a single user's chat history (messages + actions + attachments).
// Called from /api/auth/login and /api/auth/logout so the chat panel
// starts fresh on every session and the DB doesn't fill up with stale
// conversation rows.
export async function clearChatForUser(user_id) {
  return dbCore.clearChatForUser(user_id);
}
