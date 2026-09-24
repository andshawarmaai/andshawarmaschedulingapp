import { test } from 'node:test';
import assert from 'node:assert/strict';
import { groupDayItemsByTemplate, computeDayCoverage } from '../src/lib/client/coverage.js';

// 2026-09-25 is a Friday (day 5).
const DATE = '2026-09-25';
const templates = [
  { id: 'open', name: 'Opener', start_time: '09:00', end_time: '21:30', days_of_week: '0,1,2,3,4,5,6', min_staff: 1, max_staff: 1 },
  { id: 'mid', name: 'Mid AM', start_time: '09:00', end_time: '18:00', days_of_week: '5', min_staff: null, max_staff: 3 },
];
const shift = (id, start_time, end_time) => ({ id, user_id: `u-${id}`, date: DATE, start_time, end_time });

test('Day view columns: only exact template times go in a template column', () => {
  const shifts = [shift('a', '09:00', '18:00'), shift('b', '10:00', '14:00'), shift('c', '09:00:00', '21:30:00')];
  const { groups, unmatched } = groupDayItemsByTemplate(templates, shifts, [], DATE, { exact: true });
  const byId = Object.fromEntries(groups.map((g) => [g.template.id, g.approved.map((s) => s.id)]));
  assert.deepEqual(byId.mid, ['a']);
  assert.deepEqual(byId.open, ['c']); // seconds in the time don't matter
  assert.deepEqual(unmatched.map((u) => u.row.id), ['b']); // 10-2 fits inside both, matches neither
});

test('Coverage still uses best-fit containment (counts are unchanged)', () => {
  const shifts = [shift('b', '10:00', '14:00')];
  const mid = computeDayCoverage(templates, shifts, [], DATE).find((c) => c.template.id === 'mid');
  assert.equal(mid.count, 1);
});
