// Small formatting helpers shared by the client-side page scripts.

export function todayISO() {
  return new Date().toISOString().slice(0, 10);
}

export function formatDate(iso, opts = {}) {
  const d = new Date(iso + 'T00:00:00');
  if (opts.short) {
    return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  }
  if (opts.monthYear) {
    return d.toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
  }
  return d.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });
}

export function formatTime12(t) {
  if (!t) return '';
  const [h, m] = t.split(':').map(Number);
  const period = h >= 12 ? 'PM' : 'AM';
  const hour = h % 12 || 12;
  return `${hour}:${String(m).padStart(2, '0')} ${period}`;
}

export function daysBetween(startISO, endISO) {
  const s = new Date(startISO + 'T00:00:00');
  const e = new Date(endISO + 'T00:00:00');
  return Math.round((e - s) / 86400000);
}

export function getMonthCells(year, month) {
  // month is 1-12. Returns 6*7 cells for a standard month calendar grid.
  const first = new Date(year, month - 1, 1);
  const firstDow = first.getDay();
  const daysInMonth = new Date(year, month, 0).getDate();
  const cells = [];
  for (let i = 0; i < firstDow; i++) {
    const d = new Date(first);
    d.setDate(d.getDate() - (firstDow - i));
    cells.push({ iso: d.toISOString().slice(0, 10), other: true });
  }
  for (let i = 1; i <= daysInMonth; i++) {
    const iso = `${year}-${String(month).padStart(2, '0')}-${String(i).padStart(2, '0')}`;
    cells.push({ iso, other: false });
  }
  while (cells.length % 7 !== 0) {
    const last = new Date(cells[cells.length - 1].iso + 'T00:00:00');
    last.setDate(last.getDate() + 1);
    cells.push({ iso: last.toISOString().slice(0, 10), other: true });
  }
  return cells;
}

export function isBlocked(timeOff, iso, userId) {
  return timeOff.some(
    (t) => t.user_id === userId && t.status === 'approved' && iso >= t.start_date && iso <= t.end_date
  );
}

export function escapeHtml(str) {
  return String(str ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

export function slotStatus(dayCaps, shifts, date, startTime) {
  const cap = dayCaps.find((c) => c.date === date && startTime >= c.window_start && startTime < c.window_end);
  if (!cap) return null;
  const count = shifts.filter((s) => s.date === date && s.start_time >= cap.window_start && s.start_time < cap.window_end).length;
  return { cap, count, full: count >= cap.max_shifts };
}
