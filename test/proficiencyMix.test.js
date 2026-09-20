import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evaluateProficiencyMix } from '../src/lib/proficiencyMix.js';

// PRD section 9.1 golden scenario: "Friday peak requires one Advanced
// shawarma employee and at least three Proficient+ employees — optimizer
// must satisfy team mix before using performance to optimize remaining
// assignments."
test('satisfied when the advanced anchor and proficient-plus count are both met', () => {
  const requirements = [{ job_id: 'shawarma', min_count: 6, min_advanced_count: 1, min_proficient_or_better_count: 3 }];
  const assignments = [
    { user_id: 'a', job_id: 'shawarma', proficiency: 'advanced' },
    { user_id: 'b', job_id: 'shawarma', proficiency: 'proficient' },
    { user_id: 'c', job_id: 'shawarma', proficiency: 'proficient' },
    { user_id: 'd', job_id: 'shawarma', proficiency: 'developing' },
    { user_id: 'e', job_id: 'shawarma', proficiency: 'developing' },
    { user_id: 'f', job_id: 'shawarma', proficiency: null },
  ];
  const [result] = evaluateProficiencyMix({ requirements, assignments });
  assert.equal(result.satisfied, true);
  assert.deepEqual(result.gaps, []);
  assert.equal(result.actual_count, 6);
  assert.equal(result.actual_advanced_count, 1);
  assert.equal(result.actual_proficient_or_better_count, 3);
});

test('flags MIN_PROFICIENCY_MIX_GAP when the advanced anchor is missing, even with enough total headcount', () => {
  const requirements = [{ job_id: 'shawarma', min_count: 2, min_advanced_count: 1, min_proficient_or_better_count: 0 }];
  const assignments = [
    { user_id: 'a', job_id: 'shawarma', proficiency: 'proficient' },
    { user_id: 'b', job_id: 'shawarma', proficiency: 'developing' },
  ];
  const [result] = evaluateProficiencyMix({ requirements, assignments });
  assert.equal(result.satisfied, false);
  assert.equal(result.actual_count, 2); // headcount itself is fine
  assert.equal(result.gaps.length, 1);
  assert.equal(result.gaps[0].code, 'MIN_PROFICIENCY_MIX_GAP');
});

test('flags REQUIRED_COVERAGE_GAP when plain headcount is short — PRD "approved time off makes one role infeasible" scenario', () => {
  const requirements = [{ job_id: 'line', min_count: 2, min_advanced_count: 0, min_proficient_or_better_count: 0 }];
  const assignments = [{ user_id: 'a', job_id: 'line', proficiency: 'proficient' }];
  const [result] = evaluateProficiencyMix({ requirements, assignments });
  assert.equal(result.satisfied, false);
  assert.equal(result.gaps[0].code, 'REQUIRED_COVERAGE_GAP');
});

// PRD section 9.1: "Performance signal has only two shifts of evidence —
// low-confidence signal cannot dominate assignment ranking." Applied here:
// someone with no proficiency profile set at all must never silently count
// as meeting a proficiency-tier minimum just because they're assigned.
test('an assigned person with no proficiency profile counts toward headcount only, never toward a proficiency-tier minimum', () => {
  const requirements = [{ job_id: 'shawarma', min_count: 1, min_advanced_count: 1, min_proficient_or_better_count: 0 }];
  const assignments = [{ user_id: 'a', job_id: 'shawarma', proficiency: null }];
  const [result] = evaluateProficiencyMix({ requirements, assignments });
  assert.equal(result.actual_count, 1);
  assert.equal(result.actual_advanced_count, 0);
  assert.equal(result.satisfied, false);
  assert.equal(result.gaps[0].code, 'MIN_PROFICIENCY_MIX_GAP');
});

test('advanced counts toward the proficient-or-better bucket too, not just its own tier', () => {
  const requirements = [{ job_id: 'shawarma', min_count: 1, min_advanced_count: 0, min_proficient_or_better_count: 1 }];
  const assignments = [{ user_id: 'a', job_id: 'shawarma', proficiency: 'advanced' }];
  const [result] = evaluateProficiencyMix({ requirements, assignments });
  assert.equal(result.actual_proficient_or_better_count, 1);
  assert.equal(result.satisfied, true);
});

test('a job with zero required minimums (min_advanced_count/min_proficient_or_better_count both 0) is satisfied by headcount alone', () => {
  const requirements = [{ job_id: 'cashier', min_count: 1, min_advanced_count: 0, min_proficient_or_better_count: 0 }];
  const assignments = [{ user_id: 'a', job_id: 'cashier', proficiency: 'developing' }];
  const [result] = evaluateProficiencyMix({ requirements, assignments });
  assert.equal(result.satisfied, true);
});

test('evaluates every requirement independently — a satisfied job does not mask a gapped one', () => {
  const requirements = [
    { job_id: 'shawarma', min_count: 1, min_advanced_count: 1, min_proficient_or_better_count: 0 },
    { job_id: 'cashier', min_count: 1, min_advanced_count: 0, min_proficient_or_better_count: 0 },
  ];
  const assignments = [
    { user_id: 'a', job_id: 'shawarma', proficiency: 'advanced' },
    { user_id: 'b', job_id: 'cashier', proficiency: 'developing' },
  ];
  const results = evaluateProficiencyMix({ requirements, assignments });
  assert.equal(results.find((r) => r.job_id === 'shawarma').satisfied, true);
  assert.equal(results.find((r) => r.job_id === 'cashier').satisfied, true);
});
