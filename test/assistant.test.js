import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseAgentOutput, greetingReply, isAllowedAction } from '../src/lib/assistant.js';

test('parseAgentOutput pulls the actions block out of the reply', () => {
  const text = 'Done — Jorge is on Friday.\n\n```json\n{"actions":[{"method":"POST","endpoint":"/api/shifts","body":{"user_id":"u1"},"summary":"Scheduled Jorge"}]}\n```';
  const { content, actions } = parseAgentOutput(text);
  assert.equal(content, 'Done — Jorge is on Friday.');
  assert.equal(actions.length, 1);
  assert.equal(actions[0].endpoint, '/api/shifts');
});

test('parseAgentOutput keeps plain answers and survives a malformed block', () => {
  assert.deepEqual(parseAgentOutput('Jorge and Bhanu are on Thursday.'), { content: 'Jorge and Bhanu are on Thursday.', actions: [] });
  assert.deepEqual(parseAgentOutput('Hi ```json {oops``` there').actions, []);
});

test('greetingReply answers bare greetings only', () => {
  assert.ok(greetingReply('hello'));
  assert.equal(greetingReply('hi can you add jorge friday'), null);
});

test('chat can never approve, change settings, keys or sign-in', () => {
  assert.equal(isAllowedAction('POST', '/api/shifts'), true);
  assert.equal(isAllowedAction('DELETE', '/api/shifts/abc'), true);
  assert.equal(isAllowedAction('POST', '/api/shift-requests/abc/approve'), false);
  assert.equal(isAllowedAction('POST', '/api/timeoff/abc/deny'), false);
  assert.equal(isAllowedAction('POST', '/api/admin/settings/ai'), false);
  assert.equal(isAllowedAction('POST', '/api/admin/api-keys'), false);
  assert.equal(isAllowedAction('POST', '/api/auth/login'), false);
  assert.equal(isAllowedAction('GET', 'https://evil.example/steal'), false);
});

test('file blocks in a reply become downloadable attachments', async () => {
  const { extractFileBlocks } = await import('../src/lib/assistant.js');
  const { text, files } = extractFileBlocks('Here is the week.\n\n```file name="week.csv"\ndate,name\n2026-10-05,Jorge\n```');
  assert.equal(text, 'Here is the week.');
  assert.equal(files.length, 1);
  assert.equal(files[0].name, 'week.csv');
  assert.equal(files[0].type, 'text/csv');
  assert.equal(Buffer.from(files[0].b64, 'base64').toString(), 'date,name\n2026-10-05,Jorge');
});
