// Sprint 3 (PRD EPIC 6, WB-SCH-501): "As a manager, I can generate a
// candidate schedule from configured requirements and constraints."
// Read-only — builds and returns a proposal, writes nothing. A manager
// reviews it and calls .../apply (below) to actually create shifts; the
// PRD is explicit that the AI/optimizer never publishes on its own
// (section 1.2, "Manager remains accountable").
import db from '../../../../lib/db/index.js';
import { templatesForDate } from '../../../../lib/coverage.js';
import { generateCandidateSchedule } from '../../../../lib/scheduleOptimizer.js';

export const prerender = false;

function json(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
}

// Sunday-through-Saturday, matching this app's existing days_of_week
// convention (0=Sun..6=Sat) elsewhere (tierLimits.js, shift_templates).
function weekRangeContaining(dateStr) {
  const d = new Date(`${dateStr}T00:00:00`);
  const start = new Date(d);
  start.setDate(d.getDate() - d.getDay());
  const end = new Date(start);
  end.setDate(start.getDate() + 6);
  return [start.toISOString().slice(0, 10), end.toISOString().slice(0, 10)];
}

export async function POST(context) {
  const body = await context.request.json().catch(() => null);
  if (!body || !body.date) return json({ error: 'date (YYYY-MM-DD) is required.' }, 400);
  const { date } = body;

  const [allTemplates, allShifts, users, employeeJobs, roleProfiles, timeOff] = await Promise.all([
    db.listShiftTemplates(), db.listShifts(), db.listUsers(), db.listEmployeeJobs(), db.listEmployeeRoleProfiles(), db.listTimeOff(),
  ]);

  const dayTemplates = templatesForDate(allTemplates, date);
  if (dayTemplates.length === 0) return json({ ok: true, date, slots: [], assignments: [], unfilled: [], note: 'No shift templates apply to this date.' });

  const requirementsByTemplate = new Map();
  await Promise.all(dayTemplates.map(async (t) => {
    requirementsByTemplate.set(t.id, await db.listTemplateJobRequirements(t.id));
  }));

  // One slot per template+job requirement; a template with no configured
  // job requirements falls back to a single job-agnostic slot sized to
  // its existing min_staff — preserves today's manual-scheduling behavior
  // for anyone who hasn't set up Sprint 2's peak-staffing-mix yet.
  const slots = [];
  for (const t of dayTemplates) {
    const reqs = requirementsByTemplate.get(t.id) || [];
    if (reqs.length === 0) {
      if (t.min_staff) {
        slots.push({ template_id: t.id, job_id: null, start_time: t.start_time, end_time: t.end_time, quantity: t.min_staff, min_advanced_count: 0, min_proficient_or_better_count: 0 });
      }
      continue;
    }
    for (const r of reqs) {
      slots.push({
        template_id: t.id, job_id: r.job_id, start_time: t.start_time, end_time: t.end_time,
        quantity: r.min_count, min_advanced_count: r.min_advanced_count, min_proficient_or_better_count: r.min_proficient_or_better_count,
      });
    }
  }

  const employeeJobsByUser = new Map();
  for (const ej of employeeJobs) {
    if (!employeeJobsByUser.has(ej.user_id)) employeeJobsByUser.set(ej.user_id, new Map());
    employeeJobsByUser.get(ej.user_id).set(ej.job_id, ej.qualification_state);
  }
  const proficiencyByUserJob = new Map(roleProfiles.map((p) => [`${p.user_id}::${p.job_id}`, p.proficiency]));

  const unavailableUserIds = new Set(
    timeOff.filter((t) => t.status === 'approved' && t.start_date <= date && date <= t.end_date).map((t) => t.user_id),
  );
  const existingShiftsForDate = allShifts.filter((s) => s.date === date);

  const [weekStart, weekEnd] = weekRangeContaining(date);
  const hoursThisWeekByUser = new Map();
  for (const s of allShifts) {
    if (s.date < weekStart || s.date > weekEnd) continue;
    const [start, end] = [s.start_time, s.end_time].map((t) => t);
    const startMin = Number(start.slice(0, 2)) * 60 + Number(start.slice(3, 5));
    let endMin = Number(end.slice(0, 2)) * 60 + Number(end.slice(3, 5));
    if (endMin <= startMin) endMin += 24 * 60;
    hoursThisWeekByUser.set(s.user_id, (hoursThisWeekByUser.get(s.user_id) || 0) + (endMin - startMin) / 60);
  }

  const activeEmployees = users.filter((u) => !u.disabled).map((u) => ({ id: u.id }));

  const { assignments, unfilled } = generateCandidateSchedule({
    date, slots,
    context: { employees: activeEmployees, employeeJobsByUser, proficiencyByUserJob, unavailableUserIds, existingShiftsForDate, hoursThisWeekByUser },
  });

  const usersById = new Map(users.map((u) => [u.id, u]));
  const assignmentsWithNames = assignments.map((a) => ({ ...a, display_name: usersById.get(a.user_id)?.display_name || 'Unknown' }));

  // Immutable snapshot of exactly what was proposed, before the manager
  // gets a chance to accept/edit/reject any of it (Sprint 4, PRD EPIC 7) —
  // written even if nothing ever gets applied, so "what did the system
  // propose" is answerable regardless of what a manager did with it.
  const generation = await db.createScheduleGeneration({
    date, generated_by: context.locals.user.id,
    proposal: { slots, assignments: assignmentsWithNames, unfilled },
  });

  return json({ ok: true, generation_id: generation.id, date, slots, assignments: assignmentsWithNames, unfilled });
}
