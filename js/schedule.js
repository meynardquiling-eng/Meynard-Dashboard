/*
  Attendance schedule rules, shared by the Attendance tab and described for the Slack routine in ATTENDANCE.md.
  If you change a time here, update ATTENDANCE.md and the routine prompts too.
*/
TrainerHub.schedule = (function () {
  const TIME_ZONE = "America/Chicago"; // Central time, switches between CDT and CST automatically
  const POST_TIME = "6:55 AM";
  const PRESENT_BY = 7 * 60;       // reply at 7:00 or earlier (minutes after midnight) = Present
  const LATE_BY = 7 * 60 + 15;     // reply 7:01–7:15 = Late; no reply by then = Absent
  const TRAINING_DAYS = 20;        // 4 weeks, Monday to Friday

  const pad = (n) => String(n).padStart(2, "0");

  // Calendar date and minutes-after-midnight in Central time for a moment (default: now).
  function central(moment = new Date()) {
    const parts = Object.fromEntries(
      new Intl.DateTimeFormat("en-US", {
        timeZone: TIME_ZONE, year: "numeric", month: "2-digit", day: "2-digit",
        hour: "2-digit", minute: "2-digit", hourCycle: "h23",
      }).formatToParts(new Date(moment)).map((p) => [p.type, p.value])
    );
    return { date: `${parts.year}-${parts.month}-${parts.day}`, minutes: Number(parts.hour) * 60 + Number(parts.minute) };
  }

  // The 20 weekday dates of a cohort's training, starting at its start date
  // (a weekend start date moves to the following Monday).
  function trainingDays(startDate) {
    if (!startDate) return [];
    const [y, m, d] = startDate.split("-").map(Number);
    const day = new Date(Date.UTC(y, m - 1, d));
    const days = [];
    while (days.length < TRAINING_DAYS) {
      const dow = day.getUTCDay();
      if (dow !== 0 && dow !== 6) days.push(`${day.getUTCFullYear()}-${pad(day.getUTCMonth() + 1)}-${pad(day.getUTCDate())}`);
      day.setUTCDate(day.getUTCDate() + 1);
    }
    return days;
  }

  // Where a cohort is in its 4 weeks today.
  function progress(cohort) {
    const days = trainingDays(cohort.startDate);
    const today = central().date;
    if (!days.length) return { days, today, phase: "unscheduled" };
    if (today < days[0]) return { days, today, phase: "upcoming" };
    if (today > days[days.length - 1]) return { days, today, phase: "finished" };
    const index = days.filter((d) => d <= today).length - 1; // last training day on or before today
    return { days, today, phase: "running", index, isTrainingDay: days[index] === today };
  }

  // Status for a reply sent at `moment`, judged in Central time; null if too late to count.
  function statusForReply(moment) {
    const { minutes } = central(moment);
    if (minutes <= PRESENT_BY) return "present";
    if (minutes <= LATE_BY) return "late";
    return null;
  }

  // True once today's results are final (after the late cutoff).
  const isPastCutoff = () => central().minutes > LATE_BY;

  const timeLabel = (moment) =>
    new Date(moment).toLocaleTimeString("en-US", { timeZone: TIME_ZONE, hour: "numeric", minute: "2-digit" });

  return { TIME_ZONE, POST_TIME, PRESENT_BY, LATE_BY, TRAINING_DAYS, central, trainingDays, progress, statusForReply, isPastCutoff, timeLabel };
})();
