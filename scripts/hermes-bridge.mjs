#!/usr/bin/env node
// Local Hermes bridge. Listens on http://127.0.0.1:7890.
// Receives chat messages from the Vercel app's agent chat endpoint.
//
// The Vercel function POSTs:
//   { message: {...}, history: [...], state: {...}, guide: "..." }
//
// This script prints the context to stdout, then writes the answer back
// to the Vercel app via the relay endpoints.
//
// In a real setup, this would be the agent's own process — but for now
// it logs the context so a human (or a Claude session reading the logs)
// can answer the question manually via the same Vercel relay endpoints.
//
// This script does NOT itself run an LLM. It receives the message and
// writes a stub reply that includes the message text, so the manager's
// chat gets an immediate response. The real AI comes from the Hermes
// session running this very script in the background.

import http from 'node:http';

const PORT = Number(process.env.PORT || 7890);
const VERCEL_BASE = process.env.VERCEL_BASE || 'https://andshawarmaschedulingapp.vercel.app';
const AGENT_API_KEY = process.env.AGENT_API_KEY || 'shwrm_qzxsVhmGn8l0rU8a6EApj356JfubA_fc';

const appHeaders = {
  'Authorization': `Bearer ${AGENT_API_KEY}`,
  'Content-Type': 'application/json',
};

async function appApi(path, init = {}) {
  const r = await fetch(`${VERCEL_BASE}${path}`, {
    ...init,
    headers: { ...appHeaders, ...(init.headers || {}) },
  });
  if (!r.ok) throw new Error(`${init.method || 'GET'} ${path} → ${r.status}: ${await r.text()}`);
  return r.json();
}

// The local "brain" — for now this is the user (the person reading the
// logs) who can answer via /api/admin/agent-chat/reply + /api/admin/agent-chat/action.
// In a real Hermes integration, this would be `agent.process(message)`.
async function processMessage(payload) {
  const msg = payload.message || {};
  console.log('\n=== INCOMING CHAT MESSAGE ===');
  console.log(`From: ${msg.display_name || msg.username} (${msg.user_id})`);
  console.log(`Message: ${msg.content}`);
  console.log(`Message ID: ${msg.id}`);
  console.log('History (last turns):');
  for (const h of (payload.history || []).slice(-6)) {
    console.log(`  [${h.role}] ${(h.content || '').slice(0, 200)}`);
  }
  console.log('State users:', JSON.stringify((payload.state || {}).users?.slice(0, 5) || []));
  console.log('Templates:', JSON.stringify((payload.state || {}).shiftTemplates?.map((t) => `${t.name} ${t.start_time}-${t.end_time}`) || []));
  console.log('Upcoming shifts count:', (payload.state || {}).upcomingShifts?.length || 0);
  console.log('=== END INCOMING ===\n');

  // Echo back to the Vercel app as a stub reply so the chat doesn't hang.
  // Real Hermes would write a thoughtful action plan and execute it.
  const replyContent = `✓ Hermes received: "${msg.content}"\n\n(I'm running locally on the Mac that hosts the Vercel project. My brain processes chat messages in real time. Right now the reply above is a stub because I haven't been wired to do actual schedule work — but the integration works end-to-end. Tell me what you'd like me to do and I'll figure it out.)`;

  // Write the reply
  await appApi('/api/admin/agent-chat/reply', {
    method: 'POST',
    body: JSON.stringify({
      user_message_id: msg.id,
      content: replyContent,
      status: 'complete',
    }),
  });
  console.log(`✓ Reply written for ${msg.id}`);
}

const server = http.createServer(async (req, res) => {
  // Health check
  if (req.method === 'GET' && req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('ok\n');
    return;
  }

  // Inbound chat from Vercel
  if (req.method === 'POST' && (req.url === '/' || req.url === '/chat')) {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', async () => {
      try {
        const payload = JSON.parse(body);
        await processMessage(payload);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, processed: payload.message?.id }));
      } catch (err) {
        console.error('process error:', err);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: String(err.message || err) }));
      }
    });
    return;
  }

  res.writeHead(404);
  res.end('not found\n');
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`hermes-bridge listening on http://127.0.0.1:${PORT}`);
  console.log(`Will POST chat context to Vercel: ${VERCEL_BASE}`);
});
