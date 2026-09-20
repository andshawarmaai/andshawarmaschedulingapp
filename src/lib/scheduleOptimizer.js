// Sprint 3 (PRD EPIC 6): deterministic candidate-schedule generation.
// Pure, no I/O — the caller fetches everything from the DB and hands it
// in, so this is directly unit-testable and mirrors the PRD's own
// "optimizer returns candidates, does not own persistence" contract
// (section 6.2): nothing here writes a shift row. A separate, explicit
// "apply" step (an admin action) does that.
//
// This is a layered greedy assignment, not a CP-SAT solver — appropriate
// for a single-location weekly roster (dozens of employees, a handful of
// slots), and it still honors the PRD's actual ordering requirement:
// hard feasibility first, then mandatory proficiency-mix coverage, then
// weighted soft objectives (here: fairness, via fewest-hours-so-far).
// Swap this internals out for a real constraint solver later without
// changing the function's contract if the roster ever outgrows greedy.

import { toMinutes, shiftRange } from './coverage.js';

const PROFICIENCY_RANK = { developing: 0, proficient: 1, advanced: 2 };

function overlaps(aStart, aEnd, bStart, bEnd) {
  return aStart < bEnd && bStart < aEnd;
}

// Slot start/end can cross midnight (mirrors coverage.js's shiftRange);
// treat both the candidate slot and every existing/placed shift the same
// way before comparing.
function rangeOf(startTime, endTime) {
  const start = toMinutes(startTime);
  let end = toMinutes(endTime);
  if (end <= start) end += 24 * 60;
  return [start, end];
}

// One ShiftSlot to fill: { template_id, job_id (null = job-agnostic, matches
// today's existing behavior for a template with no configured job
// requirements), start_time, end_time, quantity, min_advanced_count,
// min_proficient_or_better_count }.
//
// context: {
//   employees: [{ id }],
//   employeeJobsByUser: Map<user_id, Map<job_id, qualification_state>>,
//   proficiencyByUserJob: Map<`${user_id}::${job_id}`, proficiency>,
//   unavailableUserIds: Set<user_id>  — approved time off covering this date
//   existingShiftsForDate: [{ user_id, start_time, end_time }] — already on
//     the books for this date (untouched, locked — never reassigned)
//   hoursThisWeekByUser: Map<user_id, number> — for fairness tie-breaking;
//     the caller owns what "this week" means (see PRD's own workweek note)
// }
export function generateCandidateSchedule({ date, slots, context }) {
  const {
    employees, employeeJobsByUser, proficiencyByUserJob,
    unavailableUserIds = new Set(), existingShiftsForDate = [], hoursThisWeekByUser = new Map(),
  } = context;

  // Running state this generation run mutates as it fills slots, so a
  // later slot never double-books someone the earlier slots already
  // placed, and fairness hours update as we go (PRD: "optimize today,
  // develop tomorrow" — spreading hours is itself part of the objective,
  // not just a post-hoc report).
  const placedShiftsByUser = new Map(); // user_id -> [{start,end}] (minutes, this run only)
  const runHours = new Map(hoursThisWeekByUser); // cloned so the caller's map isn't mutated

  function isBusy(userId, start, end) {
    const existing = (existingShiftsForDate || []).filter((s) => s.user_id === userId);
    for (const s of existing) {
      const [es, ee] = shiftRange(s);
      if (overlaps(start, end, es, ee)) return true;
    }
    for (const p of placedShiftsByUser.get(userId) || []) {
      if (overlaps(start, end, p.start, p.end)) return true;
    }
    return false;
  }

  function proficiencyFor(userId, jobId) {
    return proficiencyByUserJob.get(`${userId}::${jobId}`) || null;
  }

  function isQualified(userId, jobId) {
    if (!jobId) return true; // job-agnostic slot — anyone is eligible, matches today's manual-scheduling behavior
    const jobs = employeeJobsByUser.get(userId);
    return !!jobs && jobs.get(jobId) === 'qualified';
  }

  const assignments = [];
  const unfilled = [];

  for (const slot of slots) {
    const [slotStart, slotEnd] = rangeOf(slot.start_time, slot.end_time);
    const durationHours = (slotEnd - slotStart) / 60;

    let pool = employees
      .map((e) => e.id)
      .filter((userId) => !unavailableUserIds.has(userId))
      .filter((userId) => isQualified(userId, slot.job_id))
      .filter((userId) => !isBusy(userId, slotStart, slotEnd));

    // Fairness tiebreak: fewest hours already assigned/placed this week
    // first, so the optimizer doesn't habitually hand every open shift to
    // whoever it already picked earlier in this same run.
    const byFairness = (a, b) => (runHours.get(a) || 0) - (runHours.get(b) || 0);

    const filled = [];
    const reasonsByUser = new Map();

    function take(candidates, needed, tag) {
      const sorted = candidates.filter((u) => !filled.includes(u)).sort(byFairness);
      const picked = sorted.slice(0, needed);
      for (const u of picked) {
        filled.push(u);
        reasonsByUser.set(u, [...(reasonsByUser.get(u) || []), tag]);
      }
      return picked.length;
    }

    // Layer 1: the proficiency-mix anchor requirement (advanced) — filled
    // first so a later, more generic pass can never accidentally use up
    // the one Advanced person on a slot that didn't need them to be.
    const advancedPool = pool.filter((u) => PROFICIENCY_RANK[proficiencyFor(u, slot.job_id)] === PROFICIENCY_RANK.advanced);
    const advancedFilled = slot.min_advanced_count > 0 ? take(advancedPool, slot.min_advanced_count, 'PEAK_MIX_ADVANCED') : 0;

    // Layer 2: proficient-or-better minimum — advanced people already
    // placed in layer 1 count toward this too (PRD: advanced counts
    // toward "proficient or better" too, it's not a separate bucket).
    const stillNeededProfPlus = Math.max(0, slot.min_proficient_or_better_count - advancedFilled);
    const profPlusPool = pool.filter((u) => PROFICIENCY_RANK[proficiencyFor(u, slot.job_id)] >= PROFICIENCY_RANK.proficient);
    take(profPlusPool, stillNeededProfPlus, 'PEAK_MIX_PROFICIENT_PLUS');

    // Layer 3: fill remaining headcount with anyone left eligible,
    // including Developing employees — this is the workforce-development
    // pairing the PRD asks for (WB-SCH-257): once the mandatory mix is
    // protected, a Developing employee is a normal, welcome candidate for
    // the rest of the slot, not last-resort filler.
    const stillNeededTotal = Math.max(0, slot.quantity - filled.length);
    take(pool, stillNeededTotal, 'COVERAGE_FILL');

    for (const userId of filled) {
      assignments.push({
        user_id: userId, job_id: slot.job_id, template_id: slot.template_id, date,
        start_time: slot.start_time, end_time: slot.end_time,
        reason_codes: reasonsByUser.get(userId),
      });
      if (!placedShiftsByUser.has(userId)) placedShiftsByUser.set(userId, []);
      placedShiftsByUser.get(userId).push({ start: slotStart, end: slotEnd });
      runHours.set(userId, (runHours.get(userId) || 0) + durationHours);
    }

    if (filled.length < slot.quantity) {
      const gaps = [];
      if (filled.length < slot.quantity) gaps.push({ code: 'REQUIRED_COVERAGE_GAP', message: `Needs ${slot.quantity}, filled ${filled.length}.` });
      if (advancedFilled < slot.min_advanced_count) gaps.push({ code: 'MIN_PROFICIENCY_MIX_GAP', message: `Needs ${slot.min_advanced_count} Advanced, filled ${advancedFilled}.` });
      unfilled.push({ template_id: slot.template_id, job_id: slot.job_id, quantity: slot.quantity, filled: filled.length, gaps });
    } else if (advancedFilled < slot.min_advanced_count) {
      // Headcount is full but the anchor requirement specifically wasn't
      // met (e.g. quantity was already satisfied by non-advanced people
      // before an advanced candidate was available) — still a real gap
      // worth surfacing even though the slot "looks" full.
      unfilled.push({
        template_id: slot.template_id, job_id: slot.job_id, quantity: slot.quantity, filled: filled.length,
        gaps: [{ code: 'MIN_PROFICIENCY_MIX_GAP', message: `Needs ${slot.min_advanced_count} Advanced, filled ${advancedFilled}.` }],
      });
    }
  }

  return { assignments, unfilled };
}
