/*
  Sample data. Replace this file (or swap it for API calls) to use real cohorts.
  Everything below is example data, not real trainees.
*/
window.TrainerHub.data = {
  today: "Mon 12 Oct",

  modules: [
    { id: "m1", title: "Homeaglow basics", materials: ["Slides", "Welcome guide"] },
    { id: "m2", title: "Booking flow", materials: ["Slides", "Booking walkthrough", "Practice sheet"] },
    { id: "m3", title: "Rescheduling & cancellations", materials: ["Slides", "Policy doc", "Call script"] },
    { id: "m4", title: "Refunds & credits", materials: ["Slides", "Refund matrix"] },
    { id: "m5", title: "Nesting", materials: ["Shadowing checklist", "QA rubric"] },
  ],

  // Question bank per module, used by the Quiz Generator. `answer` is the index of the correct option.
  questions: {
    m1: [
      { q: "What does a customer book through Homeaglow?", options: ["A home cleaning", "A plumber", "A food delivery"], answer: 0 },
      { q: "Who performs the clean?", options: ["A Homeaglow employee", "An independent cleaner", "The customer"], answer: 1 },
      { q: "Where should you check a customer's booking history first?", options: ["Their email", "The CRM profile", "Slack"], answer: 1 },
    ],
    m2: [
      { q: "What must be confirmed before a booking is placed?", options: ["Address and date", "Cleaner's phone number", "Payment refund"], answer: 0 },
      { q: "A customer wants a cleaner they've used before. What do you check?", options: ["Their availability", "Their home address", "Their payout history"], answer: 0 },
      { q: "When does the customer receive a booking confirmation?", options: ["Right after booking", "After the clean", "Never"], answer: 0 },
    ],
    m3: [
      { q: "A customer cancels 12 hours before the clean. What applies?", options: ["Full refund", "Late cancellation fee", "Automatic reschedule"], answer: 1 },
      { q: "Where do you log a reschedule reason?", options: ["On the booking in the CRM", "In a private note app", "Nowhere"], answer: 0 },
      { q: "No cleaner is free on the new date. What do you offer?", options: ["The nearest available dates", "A cancellation", "Nothing"], answer: 0 },
      { q: "Which is the first step when a customer asks to reschedule?", options: ["Confirm the new date works for them", "Cancel the booking", "Issue a credit"], answer: 0 },
    ],
    m4: [
      { q: "A customer is unhappy with a clean. What's the first step?", options: ["Ask what went wrong", "Refund immediately", "Close the ticket"], answer: 0 },
      { q: "Where do you find which refund applies?", options: ["The refund matrix", "A teammate's guess", "The cleaner"], answer: 0 },
    ],
    m5: [
      { q: "During nesting, who reviews your calls?", options: ["A QA coach", "The customer", "Nobody"], answer: 0 },
      { q: "What does the QA rubric score?", options: ["Call quality and accuracy", "Typing speed", "Attendance"], answer: 0 },
    ],
  },

  // attendance: one letter per past session, oldest first. P present, L late, A absent.
  cohorts: [
    {
      id: "w14", name: "Care Wave 14", stage: "Week 2 of 4", currentModule: 2,
      status: { kind: "ok", label: "On track" }, quizAvg: 85,
      trainees: [
        { name: "Ana Reyes", attendance: "PPPPPPP", quiz: 92 },
        { name: "Rey Dizon", attendance: "PPPPPPL", quiz: 88 },
        { name: "Paolo Tan", attendance: "LPPPPPP", quiz: 90 },
        { name: "Joel Santos", attendance: "PLPPLPL", quiz: 79 },
        { name: "Liza Cruz", attendance: "PPPAPPP", quiz: 86 },
        { name: "Mika Lim", attendance: "PPAAPLA", quiz: 71 },
      ],
      zoom: {
        live: { title: "M3 · Rescheduling & cancellations", startedAt: "10:00", minutes: 42, notJoined: ["Mika Lim", "Joel Santos"] },
        next: "Today 13:00 · Role-play",
        history: [
          { date: "Fri 9 Oct", title: "M2 · Booking practice", minutes: 90, joined: 6 },
          { date: "Thu 8 Oct", title: "M2 · Booking flow", minutes: 120, joined: 5 },
          { date: "Wed 7 Oct", title: "M1 · Basics review", minutes: 60, joined: 6 },
        ],
      },
    },
    {
      id: "g07", name: "CP Gen 07", stage: "Week 1 of 3", currentModule: 1,
      status: { kind: "warn", label: "3 at risk" }, quizAvg: 74,
      trainees: [
        { name: "Ben Ocampo", attendance: "PPPPP", quiz: 82 },
        { name: "Ria Soto", attendance: "PLPAP", quiz: 68 },
        { name: "Ken Uy", attendance: "PPAPA", quiz: 64 },
        { name: "Dana Lee", attendance: "PPPPL", quiz: 81 },
        { name: "Ivy Gomez", attendance: "APPPP", quiz: 72 },
      ],
      zoom: {
        live: null,
        next: "Today 13:00 · M2 Booking flow",
        history: [
          { date: "Fri 9 Oct", title: "M1 · Basics", minutes: 120, joined: 4 },
          { date: "Thu 8 Oct", title: "Kickoff", minutes: 60, joined: 5 },
        ],
      },
    },
    {
      id: "w13", name: "Care Wave 13", stage: "Nesting", currentModule: 4,
      status: { kind: "info", label: "Nesting" }, quizAvg: 88,
      trainees: [
        { name: "Tess Ramos", attendance: "PPPPPPPPPP", quiz: 93 },
        { name: "Leo Bautista", attendance: "PPPLPPPPPP", quiz: 87 },
        { name: "Nina Velasco", attendance: "PPPPPAPPPP", quiz: 85 },
        { name: "Omar Diaz", attendance: "PLPPPPPPPL", quiz: 89 },
      ],
      zoom: {
        live: null,
        next: "Tue 09:00 · Nesting huddle",
        history: [{ date: "Fri 9 Oct", title: "Nesting check-in", minutes: 45, joined: 4 }],
      },
    },
    {
      id: "qa", name: "QA Upskill B", stage: "Starts 19 Oct", currentModule: -1,
      status: { kind: "mute", label: "Upcoming" }, quizAvg: null,
      trainees: [],
      zoom: { live: null, next: "19 Oct 09:00 · Kickoff", history: [] },
    },
  ],
};
