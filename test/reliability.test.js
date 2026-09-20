import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeReliability } from '../src/lib/reliability.js';

test('counts a matching punch within the grace period as on time', () => {
  const scheduledShifts = [{ id: 's1', date: '2026-09-18', start_time: '09:00' }];
  const actualWorkedShifts = [{ shift_id: 's1', date: '2026-09-18', clock_in: '09:03' }];
  const result = computeReliability({ scheduledShifts, actualWorkedShifts });
  assert.equal(result.on_time_count, 1);
  assert.equal(result.late_count, 0);
  assert.equal(result.no_show_count, 0);
  assert.equal(result.on_time_pct, 100);
});

test('counts a punch well after the scheduled start as late, not on time', () => {
  const scheduledShifts = [{ id: 's1', date: '2026-09-18', start_time: '09:00' }];
  const actualWorkedShifts = [{ shift_id: 's1', date: '2026-09-18', clock_in: '09:20' }];
  const result = computeReliability({ scheduledShifts, actualWorkedShifts });
  assert.equal(result.late_count, 1);
  assert.equal(result.details[0].minutes_late, 20);
});

test('a scheduled shift with no matching punch at all is a no-show, never silently ignored', () => {
  const scheduledShifts = [{ id: 's1', date: '2026-09-18', start_time: '09:00' }];
  const result = computeReliability({ scheduledShifts, actualWorkedShifts: [] });
  assert.equal(result.no_show_count, 1);
  assert.equal(result.on_time_pct, 0);
});

test('on_time_pct is null (not 0 or NaN) when there is nothing scheduled to measure against', () => {
  const result = computeReliability({ scheduledShifts: [], actualWorkedShifts: [] });
  assert.equal(result.total_scheduled, 0);
  assert.equal(result.on_time_pct, null);
});

test('mixes on-time, late, and no-show correctly across multiple days', () => {
  const scheduledShifts = [
    { id: 's1', date: '2026-09-15', start_time: '09:00' },
    { id: 's2', date: '2026-09-16', start_time: '09:00' },
    { id: 's3', date: '2026-09-17', start_time: '09:00' },
  ];
  const actualWorkedShifts = [
    { shift_id: 's1', date: '2026-09-15', clock_in: '08:58' }, // on time
    { shift_id: 's2', date: '2026-09-16', clock_in: '09:30' }, // late
    // s3 has no punch at all — no-show
  ];
  const result = computeReliability({ scheduledShifts, actualWorkedShifts });
  assert.equal(result.on_time_count, 1);
  assert.equal(result.late_count, 1);
  assert.equal(result.no_show_count, 1);
  assert.equal(result.total_scheduled, 3);
});
