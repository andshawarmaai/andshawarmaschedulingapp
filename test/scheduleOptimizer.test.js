import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateCandidateSchedule } from '../src/lib/scheduleOptimizer.js';

function baseContext(overrides = {}) {
  return {
    employees: [{ id: 'a' }, { id: 'b' }, { id: 'c' }],
    employeeJobsByUser: new Map([
      ['a', new Map([['shawarma', 'qualified']])],
      ['b', new Map([['shawarma', 'qualified']])],
      ['c', new Map([['shawarma', 'qualified']])],
    ]),
    proficiencyByUserJob: new Map(),
    unavailableUserIds: new Set(),
    existingShiftsForDate: [],
    hoursThisWeekByUser: new Map(),
    ...overrides,
  };
}

// PRD 9.1: "Normal week with sufficient qualified staff — 100% coverage, no overtime."
test('fills a slot completely when enough qualified, available people exist', () => {
  const slots = [{ template_id: 't1', job_id: 'shawarma', start_time: '09:00', end_time: '17:00', quantity: 2, min_advanced_count: 0, min_proficient_or_better_count: 0 }];
  const { assignments, unfilled } = generateCandidateSchedule({ date: '2026-09-18', slots, context: baseContext() });
  assert.equal(assignments.length, 2);
  assert.equal(unfilled.length, 0);
});

// PRD 9.1: "Approved time off makes one role infeasible — return uncovered
// slot, never silently assign unavailable employee."
test('never assigns someone with approved time off, and reports the gap instead of silently under-filling', () => {
  const slots = [{ template_id: 't1', job_id: 'shawarma', start_time: '09:00', end_time: '17:00', quantity: 3, min_advanced_count: 0, min_proficient_or_better_count: 0 }];
  const context = baseContext({ unavailableUserIds: new Set(['c']) });
  const { assignments, unfilled } = generateCandidateSchedule({ date: '2026-09-18', slots, context });
  assert.ok(!assignments.some((a) => a.user_id === 'c'));
  assert.equal(assignments.length, 2);
  assert.equal(unfilled.length, 1);
  assert.equal(unfilled[0].gaps[0].code, 'REQUIRED_COVERAGE_GAP');
});

// PRD 9.1: "Friday peak requires one Advanced shawarma employee and at
// least three Proficient+ employees — optimizer must satisfy team mix
// before using performance to optimize remaining assignments."
test('satisfies the peak proficiency mix (advanced anchor + proficient-plus) before filling the rest', () => {
  const employees = ['adv', 'p1', 'p2', 'p3', 'd1', 'd2'].map((id) => ({ id }));
  const employeeJobsByUser = new Map(employees.map((e) => [e.id, new Map([['shawarma', 'qualified']])]));
  const proficiencyByUserJob = new Map([
    ['adv::shawarma', 'advanced'],
    ['p1::shawarma', 'proficient'], ['p2::shawarma', 'proficient'], ['p3::shawarma', 'proficient'],
    ['d1::shawarma', 'developing'], ['d2::shawarma', 'developing'],
  ]);
  const slots = [{ template_id: 't1', job_id: 'shawarma', start_time: '17:00', end_time: '20:00', quantity: 6, min_advanced_count: 1, min_proficient_or_better_count: 3 }];
  const context = baseContext({ employees, employeeJobsByUser, proficiencyByUserJob });
  const { assignments, unfilled } = generateCandidateSchedule({ date: '2026-09-18', slots, context });
  assert.equal(assignments.length, 6);
  assert.equal(unfilled.length, 0);
  assert.ok(assignments.find((a) => a.user_id === 'adv').reason_codes.includes('PEAK_MIX_ADVANCED'));
  const profPlusAssigned = assignments.filter((a) => ['adv', 'p1', 'p2', 'p3'].includes(a.user_id));
  assert.equal(profPlusAssigned.length, 4); // advanced + all 3 proficient, all required for the mix
});

// PRD 9.1: "Two equally eligible employees compete for incremental hours"
// — applied to the generic fill layer (no proficiency-mix on this slot):
// fairness (fewer hours already this week) breaks the tie, not always the
// same person, per WB-SCH-257's explicit "don't always pick the top
// performer" principle.
test('fairness tiebreaks the generic fill layer toward whoever has fewer hours this week already', () => {
  const slots = [{ template_id: 't1', job_id: 'shawarma', start_time: '09:00', end_time: '13:00', quantity: 1, min_advanced_count: 0, min_proficient_or_better_count: 0 }];
  const context = baseContext({ hoursThisWeekByUser: new Map([['a', 30], ['b', 5], ['c', 20]]) });
  const { assignments } = generateCandidateSchedule({ date: '2026-09-18', slots, context });
  assert.equal(assignments[0].user_id, 'b');
});

// A Developing employee is a normal candidate for a lower-risk shift once
// the mandatory mix (none configured here) is satisfied — not
// automatically passed over for a higher-tier person, matching WB-SCH-257.
test('a developing employee can be selected for a shift with no proficiency-mix requirement', () => {
  const employees = [{ id: 'adv' }, { id: 'dev' }];
  const employeeJobsByUser = new Map([
    ['adv', new Map([['shawarma', 'qualified']])],
    ['dev', new Map([['shawarma', 'qualified']])],
  ]);
  const proficiencyByUserJob = new Map([['adv::shawarma', 'advanced'], ['dev::shawarma', 'developing']]);
  const slots = [{ template_id: 't1', job_id: 'shawarma', start_time: '09:00', end_time: '13:00', quantity: 1, min_advanced_count: 0, min_proficient_or_better_count: 0 }];
  // dev has fewer hours so far this week — should win the fairness tiebreak
  // even though adv is the higher-proficiency candidate.
  const context = baseContext({ employees, employeeJobsByUser, proficiencyByUserJob, hoursThisWeekByUser: new Map([['adv', 20], ['dev', 0]]) });
  const { assignments } = generateCandidateSchedule({ date: '2026-09-18', slots, context });
  assert.equal(assignments[0].user_id, 'dev');
});

test('never double-books someone into two overlapping slots in the same generation run', () => {
  const slots = [
    { template_id: 't1', job_id: 'shawarma', start_time: '09:00', end_time: '13:00', quantity: 1, min_advanced_count: 0, min_proficient_or_better_count: 0 },
    { template_id: 't2', job_id: 'shawarma', start_time: '11:00', end_time: '15:00', quantity: 1, min_advanced_count: 0, min_proficient_or_better_count: 0 },
  ];
  // Only one qualified person exists, so the second (overlapping) slot must go unfilled rather than double-booking them.
  const context = baseContext({ employees: [{ id: 'a' }], employeeJobsByUser: new Map([['a', new Map([['shawarma', 'qualified']])]]) });
  const { assignments, unfilled } = generateCandidateSchedule({ date: '2026-09-18', slots, context });
  assert.equal(assignments.length, 1);
  assert.equal(unfilled.length, 1);
});

test('excludes someone already on the books with an overlapping shift that date', () => {
  const slots = [{ template_id: 't1', job_id: 'shawarma', start_time: '09:00', end_time: '13:00', quantity: 1, min_advanced_count: 0, min_proficient_or_better_count: 0 }];
  const context = baseContext({
    employees: [{ id: 'a' }],
    employeeJobsByUser: new Map([['a', new Map([['shawarma', 'qualified']])]]),
    existingShiftsForDate: [{ user_id: 'a', start_time: '08:00', end_time: '10:00' }],
  });
  const { assignments, unfilled } = generateCandidateSchedule({ date: '2026-09-18', slots, context });
  assert.equal(assignments.length, 0);
  assert.equal(unfilled.length, 1);
});

test('a job-agnostic slot (job_id null) admits anyone regardless of qualification, matching today\'s manual-scheduling behavior', () => {
  const slots = [{ template_id: 't1', job_id: null, start_time: '09:00', end_time: '13:00', quantity: 1, min_advanced_count: 0, min_proficient_or_better_count: 0 }];
  const context = baseContext({ employeeJobsByUser: new Map() }); // nobody qualified for anything
  const { assignments } = generateCandidateSchedule({ date: '2026-09-18', slots, context });
  assert.equal(assignments.length, 1);
});
