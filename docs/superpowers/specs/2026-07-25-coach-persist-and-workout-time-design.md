# Coach reply persistence + total workout time

Date: 2026-07-25
App: single-file PWA (`index.html`), Supabase sync.

## Problem

1. Asking the coach from the Today (workout) page navigates to the Coach tab.
   On reopening, the app always lands on Today, so the reply is not visible
   there. If the app is suspended mid-request the reply can also be lost on the
   client (the client only writes it to the DOM; the `/coach` edge function is
   what persists to `chat_messages`).
2. There is no way to record how long a workout took.

## Feature A — Coach reply held on the Today page

**Behavior.** The per-exercise "🤖 Ask Claude" button no longer switches tabs.
It sends the question to the existing `/coach` function and renders the Q + reply
in a **Coach card on the Today page**. The exchange is stored in that day's
**draft** (`draft[dKey].coach`, an array of `{role, content}`), so it survives
close/minimize and syncs via Supabase. `markComplete` already deletes the day's
draft, so the card clears automatically when the workout is marked done. The
`/coach` function still writes to `chat_messages`, so the **Coach tab remains the
full history** and a fallback if a request is interrupted before the client
receives the reply.

**Pieces.**
- `askCoachAboutExercise(name)` — rewritten to send inline instead of `goTab('coach')`.
- `sendTodayCoach(dKey, message)` — appends the user message to `draft[dKey].coach`,
  saves, shows a transient "Thinking…" state, calls `/coach` (unchanged), then
  appends the reply and repaints. Errors surface transiently (not persisted).
- `paintTodayCoach(dKey)` — fills `#today-coach-card` from `draft[dKey].coach`
  (+ pending/error state); hides the card when empty.
- `renderToday` renders an initially-hidden `#today-coach-card` (strength branch,
  where the Ask-Claude buttons live) and calls `paintTodayCoach` after render.
- Module state: `todayCoachPending`, `todayCoachError` (transient, not stored).
- Coach tab (`renderCoach` / `sendToCoach`) is untouched.

## Feature B — Manual total workout time

- A **"Total time (min)"** number field appears above Mark Complete on both
  strength and mobility days. Its value is stored in the draft
  (`draft[dKey].totalMin`) so it persists/pre-fills like notes.
- `markComplete` reads `draft[dKey].totalMin` before deleting the draft and, when
  present, adds `durationMin` (Number) to the session record:
  `{ id, date, dayType, exercises, durationMin, completedAt }`. Additive — old
  sessions without it stay valid; Supabase sync unchanged.
- The **Log tab** shows `⏱ N min` in each session's meta line when present.
- The PDF/zip export (`sessionBodyHtml`) shows total time under the heading.

## Non-goals
- No live timer (manual entry only).
- No time field on Rest days (they have no Mark Complete).
- No change to the Coach tab or the `/coach` edge function.
