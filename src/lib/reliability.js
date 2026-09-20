// Sprint 7 (PRD section 4.2 / WB-SCH-252): factual reliability signals —
// "attendance, punctuality, accepted shifts and call-outs" — computed from
// actual worked shifts vs. what was scheduled. Pure, no I/O. Deliberately
// NOT a single score: returns named counts a manager can read and judge
// for themselves, matching the PRD's explicit rejection of one opaque
// "good/bad employee" number.

function toMinutes(hhmm) {
  const [h, m] = hhmm.split(':').map(Number);
  return h * 60 + m;
}

// A punch counts as "on time" within this many minutes of the scheduled
// start — a fixed, documented grace period rather than an invented exact
// match, since POS timeclocks and schedules are rarely minute-perfect
// even for someone who's genuinely on time.
const ON_TIME_GRACE_MINUTES = 5;

// scheduledShifts / actualWorkedShifts: both already filtered to one
// user_id and the relevant date range by the caller.
export function computeReliability({ scheduledShifts, actualWorkedShifts }) {
  const actualByDate = new Map();
  for (const a of actualWorkedShifts) {
    if (!actualByDate.has(a.date)) actualByDate.set(a.date, []);
    actualByDate.get(a.date).push(a);
  }

  let onTime = 0;
  let late = 0;
  let noShow = 0;
  const details = [];

  for (const s of scheduledShifts) {
    const candidates = actualByDate.get(s.date) || [];
    // A scheduled shift already explicitly linked (shift_id) wins; failing
    // that, any punch on the same date is treated as covering it — good
    // enough for a single-shift-per-day roster, which is what this
    // platform's pilot scope assumes (PRD's own MVP stance never assumes
    // multiple same-day shifts per person need disambiguating here).
    const match = candidates.find((a) => a.shift_id === s.id) || candidates[0] || null;

    if (!match) {
      noShow++;
      details.push({ date: s.date, scheduled_start: s.start_time, status: 'no_show' });
      continue;
    }
    const scheduledStart = toMinutes(s.start_time);
    const actualStart = toMinutes(match.clock_in);
    if (actualStart <= scheduledStart + ON_TIME_GRACE_MINUTES) {
      onTime++;
      details.push({ date: s.date, scheduled_start: s.start_time, clock_in: match.clock_in, status: 'on_time' });
    } else {
      late++;
      details.push({ date: s.date, scheduled_start: s.start_time, clock_in: match.clock_in, status: 'late', minutes_late: actualStart - scheduledStart });
    }
  }

  const totalScheduled = scheduledShifts.length;
  return {
    total_scheduled: totalScheduled,
    on_time_count: onTime,
    late_count: late,
    no_show_count: noShow,
    on_time_pct: totalScheduled > 0 ? Math.round((onTime / totalScheduled) * 1000) / 10 : null,
    details,
  };
}
