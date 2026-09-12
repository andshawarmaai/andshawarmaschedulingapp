// Enforces admin-defined per-tier monthly caps on shift and time-off
// requests. Tiers themselves are invisible to staff (see admin.astro's
// Tiers card and state.js, both gated to role='admin') — the only place a
// tier's existence can surface to the assigned staff member is a denial
// reason, and that reason never names the tier, just the limit itself.
//
// A cap is checked against what the request would make true if granted —
// existing committed data (real shifts, non-denied time off) plus the new
// one — never against other still-pending requests, so approving requests
// out of order can't produce a surprise denial.

const WEEKEND_DAYS = new Set([0, 6]); // Sun, Sat

export function isWeekend(dateStr) {
  return WEEKEND_DAYS.has(new Date(`${dateStr}T00:00:00`).getDay());
}

function monthOf(dateStr) {
  return dateStr.slice(0, 7); // 'YYYY-MM'
}

function daysInRange(startDate, endDate) {
  const days = [];
  const cursor = new Date(`${startDate}T00:00:00`);
  const end = new Date(`${endDate}T00:00:00`);
  while (cursor <= end) {
    days.push(cursor.toISOString().slice(0, 10));
    cursor.setDate(cursor.getDate() + 1);
  }
  return days;
}

// Returns a denial-reason string if creating a shift on `date` for `user`
// would exceed their tier's monthly cap, or null if it's fine (including
// when the user has no tier, or their tier has no shift caps set).
export async function checkShiftCreateLimit(db, { user, date }) {
  if (!user.tier_id) return null;
  const tier = await db.getTierById(user.tier_id);
  if (!tier || (tier.max_shifts_per_month == null && tier.max_weekend_shifts_per_month == null)) {
    return null;
  }

  const month = monthOf(date);
  const shifts = await db.listShifts();
  const existingInMonth = shifts.filter((s) => s.user_id === user.id && monthOf(s.date) === month);

  if (tier.max_shifts_per_month != null && existingInMonth.length + 1 > tier.max_shifts_per_month) {
    return `You've reached your maximum of ${tier.max_shifts_per_month} shift${tier.max_shifts_per_month === 1 ? '' : 's'} this month.`;
  }
  if (isWeekend(date) && tier.max_weekend_shifts_per_month != null) {
    const weekendCount = existingInMonth.filter((s) => isWeekend(s.date)).length;
    if (weekendCount + 1 > tier.max_weekend_shifts_per_month) {
      return `You've reached your maximum of ${tier.max_weekend_shifts_per_month} weekend shift${tier.max_weekend_shifts_per_month === 1 ? '' : 's'} this month.`;
    }
  }
  return null;
}

// Same idea for a time-off request spanning start_date..end_date. A
// request that crosses a month boundary is checked against each touched
// month independently — if it would bust the cap in ANY of them, the
// whole request is denied rather than partially granted.
export async function checkTimeOffLimit(db, { user, start_date, end_date }) {
  if (!user.tier_id) return null;
  const tier = await db.getTierById(user.tier_id);
  if (!tier || (tier.max_days_off_per_month == null && tier.max_weekend_days_off_per_month == null)) {
    return null;
  }

  const newDays = daysInRange(start_date, end_date);
  const allTimeOff = await db.listTimeOff();
  const existing = allTimeOff.filter((t) => t.user_id === user.id && t.status !== 'denied');

  const monthsTouched = new Set(newDays.map(monthOf));
  for (const month of monthsTouched) {
    const newDaysInMonth = newDays.filter((d) => monthOf(d) === month);
    const newWeekendDaysInMonth = newDaysInMonth.filter(isWeekend);

    let existingDays = 0;
    let existingWeekendDays = 0;
    for (const t of existing) {
      const days = daysInRange(t.start_date, t.end_date).filter((d) => monthOf(d) === month);
      existingDays += days.length;
      existingWeekendDays += days.filter(isWeekend).length;
    }

    if (tier.max_days_off_per_month != null && existingDays + newDaysInMonth.length > tier.max_days_off_per_month) {
      return `You've reached your maximum of ${tier.max_days_off_per_month} day${tier.max_days_off_per_month === 1 ? '' : 's'} off this month.`;
    }
    if (
      tier.max_weekend_days_off_per_month != null &&
      existingWeekendDays + newWeekendDaysInMonth.length > tier.max_weekend_days_off_per_month
    ) {
      return `You've reached your maximum of ${tier.max_weekend_days_off_per_month} weekend day${tier.max_weekend_days_off_per_month === 1 ? '' : 's'} off this month.`;
    }
  }
  return null;
}
