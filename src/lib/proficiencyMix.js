// Pure evaluation of a shift template's peak-staffing-mix policy (PRD
// section 4.2 / WB-SCH-253/254) against who's actually assigned — no I/O,
// so it's testable with plain data and reusable by both a read-only
// validation endpoint and (later) the auto-generation optimizer.
//
// "At least one Advanced shawarma person and three Proficient+ people"
// means: min_count is the plain headcount for that job; min_advanced_count
// and min_proficient_or_better_count are layered minimums within that same
// headcount, not additional separate people. Someone 'advanced' also
// counts toward the 'proficient-or-better' bucket.

const PROFICIENCY_RANK = { developing: 0, proficient: 1, advanced: 2 };

// assignments: [{ user_id, job_id, proficiency }] — one row per person
// assigned to (and qualified for) this shift window, already filtered to
// the relevant date/time by the caller. A person qualified but with no
// proficiency profile set yet has proficiency: null/undefined, which
// counts toward min_count but neither of the proficiency-tier minimums.
export function evaluateProficiencyMix({ requirements, assignments }) {
  const results = [];
  for (const req of requirements) {
    const forJob = assignments.filter((a) => a.job_id === req.job_id);
    const actualCount = forJob.length;
    const actualAdvanced = forJob.filter((a) => PROFICIENCY_RANK[a.proficiency] === PROFICIENCY_RANK.advanced).length;
    const actualProficientOrBetter = forJob.filter((a) => PROFICIENCY_RANK[a.proficiency] >= PROFICIENCY_RANK.proficient).length;

    const gaps = [];
    if (actualCount < req.min_count) {
      gaps.push({ code: 'REQUIRED_COVERAGE_GAP', message: `Needs ${req.min_count}, has ${actualCount}.` });
    }
    if (req.min_advanced_count > 0 && actualAdvanced < req.min_advanced_count) {
      gaps.push({ code: 'MIN_PROFICIENCY_MIX_GAP', message: `Needs ${req.min_advanced_count} Advanced, has ${actualAdvanced}.` });
    }
    if (req.min_proficient_or_better_count > 0 && actualProficientOrBetter < req.min_proficient_or_better_count) {
      gaps.push({ code: 'MIN_PROFICIENCY_MIX_GAP', message: `Needs ${req.min_proficient_or_better_count} Proficient or better, has ${actualProficientOrBetter}.` });
    }

    results.push({
      job_id: req.job_id,
      min_count: req.min_count, actual_count: actualCount,
      min_advanced_count: req.min_advanced_count, actual_advanced_count: actualAdvanced,
      min_proficient_or_better_count: req.min_proficient_or_better_count, actual_proficient_or_better_count: actualProficientOrBetter,
      satisfied: gaps.length === 0,
      gaps,
    });
  }
  return results;
}
