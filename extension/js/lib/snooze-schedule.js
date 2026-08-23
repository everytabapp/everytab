/**
 * Advance a recurring snooze to its next occurrence strictly after `from`,
 * preserving the original clock time.
 * @param {number} dueAt
 * @param {string} recurrence
 * @param {number} from
 */
export function nextOccurrence(dueAt, recurrence, from) {
  const weekday = /^weekday:([0-6])$/.exec(recurrence);
  if (weekday) {
    const target = Number(weekday[1]);
    const next = new Date(dueAt);
    while (next.getTime() <= from || next.getDay() !== target) {
      next.setDate(next.getDate() + 1);
    }
    return next.getTime();
  }
  const weeks = /^weeks:(\d+)$/.exec(recurrence);
  const stepDays = weeks
    ? Math.max(1, Number(weeks[1])) * 7
    : recurrence === "weekly"
      ? 7
      : 1;
  const step = stepDays * 24 * 3600_000;
  let next = dueAt;
  while (next <= from) next += step;
  return next;
}
