# Start-Workout Analysis, Single-Voice Supersets & Mobility Time Inputs

Date: 2026-09-08

## Problem

Three separate Claude surfaces reason about the workout independently and can
contradict each other:

1. **Conversational coach** (`buildCoachPrompt`) — explicitly told it "can advise
   on exercise sequencing and supersets when relevant" and has trend history +
   program context, so it forms superset opinions from the logs.
2. **"Suggest order / supersets" button** (`buildSequencePrompt` /
   `suggest-sequence`) — produces the *structured* superset suggestion the user
   actually applies, but is **blind to all logged history**. It sees only today's
   planned exercise list + phase/week and reasons from generic principles.
3. **Load recommender** (`buildRecommendPrompt`) — per-exercise weights, unaffected
   by this work.

Because (1) and (2) draw on different inputs, the coach can advise against a
pairing the button then recommends. Neither looks at **time spent**
(`session.durationMin` is recorded but only displayed in the Log — it never
reaches any prompt), even though supersets exist specifically to save time.

## Goals

- Make the (relabeled) **Start workout** analysis the single authority on order /
  supersets, and ground it in the actual logs **and time spent**.
- **Agreeing to a suggestion rewrites the main workout block in place** — the
  exercises reorder to Claude's suggested sequence AND group the supersets, so the
  top-of-page workout is the definitive "what's next" and the user never scrolls to
  a separate panel to see the plan.
- Stop the conversational coach from offering competing superset/sequencing advice.
- On the two mobility days, capture time as two inputs (indoor walking + mobility
  work) that sum to the session total.

Non-goals: no timer/in-progress session state (Start workout stays advisory-only,
program is never mutated); no change to the load recommender; no change to strength
days' single time field.

## Part 1 — "Start workout" button, now log- & time-aware

### UI (index.html)
- Rename the button at `index.html:1219` from `🔀 Suggest order / supersets` to
  `▶ Start workout`. Pressing it calls `suggestSequence(...)`, which fetches the
  analysis and paints `#seq-panel`. Loading text updates to e.g.
  `🤖 Claude is analyzing your logs…`. The apply flow changes (see Part 1b) so
  agreeing rewrites the main block; the ungroup flow is folded into a single undo.

### Data sent (index.html `suggestSequence`)
The frontend currently posts `{ phase, weekNum, dayType, isDeload, exercises }`.
It cannot send raw sessions cheaply, and the backend already has DB access, so the
`suggest-sequence` function will fetch history itself (mirroring `coach/index.ts`),
rather than the frontend sending it. No new payload fields required.

### Backend (`supabase/functions/suggest-sequence/index.ts`)
- Add authenticated Supabase reads (same pattern as `coach/index.ts`): fetch the
  last N sessions (`order by date desc limit 40`).
- Compute, via shared `logic.ts` helpers:
  - `computeTrendSummary(sessions)` — existing.
  - `summarizeLastSameTypeSession(sessions, dayType)` — existing.
  - **`summarizeDurations(sessions, dayType)`** — NEW helper (see logic.ts below):
    recent session durations overall and for this day type.
- Pass these into `buildSequencePrompt`.
- Keep the JSON schema and response shape (`sequence`, `supersets`, `summary`)
  exactly as-is so the existing panel/apply code is untouched.

### Prompt (`supabase/functions/coach/logic.ts` `buildSequencePrompt`)
Extend the signature to accept `trendSummary`, `lastSameTypeSummary`, and
`durationSummary`. The prompt gains:
- A "recent progress" block (trend) and "last same-type session" block, so the
  superset decision reflects real RPE/load history — not just the textbook.
- A "time spent" block, with instructions to treat **saving time as the main
  reason to superset**: if recent sessions of this type are running long, lean
  toward supersets on non-competing/isolation work; if sessions are already short
  or RPE is drifting high, be more conservative (or recommend none).
- The `summary` should explicitly reference the time reasoning (e.g. average recent
  duration and the expected time saved).

### `summarizeDurations` (new, in logic.ts)
Input: `sessions: SessionData[]`, `dayType: string`. `SessionData` gains an optional
`durationMin?: number`. Output: a compact string, e.g.
`"Recent session times — this day type (Push): 58, 61, 55 min (avg 58). All days: avg 49 min over last 10."`
Falls back to `"No session times logged yet."` when none present. Unit-tested in
`logic.test.ts`.

## Part 1b — Apply in place: reorder + supersets, single block

Today only supersets are applied to the main list (`draft[dKey].appliedSupersets`),
and members are merely pulled adjacent; Claude's `sequence` ordering is never
applied. The exercise render loop (`index.html:1187`) walks `workout.exercises` in
natural order. Crucially, every input id/handler is already bound to each
exercise's **original index** (`ei`), and the code comment at `index.html:1129`
confirms "display reordering never desyncs the draft" — so reordering the *display*
is safe as long as we keep `ei = original index`.

### New draft state
- `draft[dKey].appliedOrder` — array of **original exercise indices** in Claude's
  suggested order. Set together with `appliedSupersets` when the user agrees.
- `appliedSupersets` stays as today (groups of original indices).
- Both are cleared together on undo and on Mark Complete.

### Applying (replaces `applySupersets`, add order mapping)
- One action — "Use this plan ✓" — maps Claude's `sequence` names to original
  indices (reusing `findExerciseIndex`) to build `appliedOrder`, and maps
  `supersets` names to index groups (existing logic) to build `appliedSupersets`.
- If a sequenced name can't be matched it's skipped; any original exercises missing
  from `appliedOrder` after mapping are appended in their original order, so no
  exercise is ever dropped from the block.
- Superset grouping wins on adjacency: when emitting in `appliedOrder`, reaching the
  first-encountered member of a group emits the whole group together (same
  leader/`emitted` logic as today), so members stay back-to-back even if the raw
  sequence interleaves them.

### Render loop (`index.html` renderToday exercises branch)
- Derive the iteration order: `const order = draftDay.appliedOrder || workout.exercises.map((_,i)=>i);`
  then iterate `order` instead of `workout.exercises.forEach`, still calling
  `renderEx(workout.exercises[ei], ei)` with the original `ei`. Group leaders emit
  the whole group as now. This makes the single Exercises card the authoritative,
  reordered "what's next" block.

### Panel after apply (collapse to summary)
- Before applying: `#seq-panel` shows the full suggestion (order list + supersets +
  summary) with a "Use this plan ✓" button.
- After applying: `#seq-panel` collapses to a one-line
  `✓ Plan applied — tap to review / undo`. Tapping expands the full suggestion again
  (with an "Undo — restore original order" control) and re-collapses. Undo clears
  both `appliedOrder` and `appliedSupersets` and re-renders. This replaces the two
  separate ungroup buttons/handlers (`ungroupSupersets`, `ungroupSupersets2`) with a
  single applied/undo state.
- The applied superset frame in the main block keeps a lightweight "Ungroup" affordance
  OR defers to the panel's undo — to avoid two competing controls, the in-frame
  Ungroup is removed and undo lives only in the collapsed panel summary. (Single
  control, matching the "single voice / single block" intent.)

## Part 2 — Coach stops competing on supersets

`supabase/functions/coach/logic.ts` `buildCoachPrompt`:
- Remove the clause "You can see their full schedule and today's exercises in
  order, so you can advise on exercise sequencing and supersets when relevant."
- Replace with a line establishing the boundary: the **Start workout** analysis is
  the authority on exercise order and supersets; if the lifter asks about pairing
  or ordering, the coach should point them to the Start workout button rather than
  inventing its own pairing. The coach keeps its focus on load, progression,
  recovery, RPE and form.
- Program context (`formatProgramContext`) is still sent — the coach may reference
  today's exercises; it just doesn't prescribe order/supersets.

## Part 3 — Mobility A & B: two time inputs

Mobility A and Mobility B are the two `checklistOnly` workouts. On those days only,
replace the single total-time field with two inputs.

### UI (index.html)
- New helper `mobilityTimeFieldsHtml(date, dayType, draftDay)` rendering:
  - `🚶 Indoor walking (min)` — bound to `draftDay.walkMin`; may be blank (= 0, no
    walk that day).
  - `🧘 Mobility work (min)` — bound to `draftDay.otherMin`.
- In `renderToday`, the `checklistOnly` branch (`index.html:1104`) calls this new
  helper instead of `totalTimeFieldHtml`. Strength/exercise days keep
  `totalTimeFieldHtml` unchanged.
- Two new oninput handlers (or one parameterized handler) persist `walkMin` /
  `otherMin` into the day draft, mirroring `upTotalTime`.

### Completion (index.html `markCompleteMobility` → `markComplete`)
- `markComplete` currently reads `draftDay.totalMin`. Extend it so that for mobility
  days it sums `walkMin` + `otherMin`:
  - Parse each as int; treat blank/NaN as 0.
  - `durationMin = walk + other`; set `session.durationMin` only when `> 0`.
  - Also store the split on the session: `session.walkMin` and `session.otherMin`
    (present only on mobility sessions) so future analysis can separate walking
    from mobility work.
- Cleanest approach: `markCompleteMobility` computes the sum and passes it to
  `markComplete` (e.g. via an optional `timeOverride` argument), leaving the
  strength path (`markCompleteExercise`) reading `totalMin` as today. This keeps
  `markComplete`'s existing single-field read intact for strength days.

### Log display
`durationMin` already renders in the Log (`index.html:1867`, `:1972`) as one total.
No change needed there — the sum shows as the session total. (Optionally the split
could be shown later; out of scope.)

## Testing

- `logic.test.ts`: add cases for `summarizeDurations` (with/without durations, day
  type filtering) and update any assertions on `buildSequencePrompt` /
  `buildCoachPrompt` text that this change alters.
- Manual: Start workout → agree → the main Exercises block reorders in place and
  groups supersets; panel collapses to the one-line applied/undo summary; undo
  restores original order; the plan survives tab switches and clears on Mark
  Complete. Mobility day shows two inputs, walking blank sums correctly, total lands
  in the session and Log; coach no longer volunteers supersets.

## Files touched

- `index.html` — button label + loading text; **apply-in-place reorder**
  (`appliedOrder` draft state, reordered render loop, "Use this plan ✓" + collapsed
  applied/undo panel, replacing the old apply/ungroup handlers); mobility two-field
  UI + handlers; `markComplete`/`markCompleteMobility` summing.
- `supabase/functions/suggest-sequence/index.ts` — fetch sessions, compute
  summaries, pass to prompt.
- `supabase/functions/coach/logic.ts` — `SessionData.durationMin`;
  `summarizeDurations`; extend `buildSequencePrompt`; trim `buildCoachPrompt`.
- `supabase/functions/coach/logic.test.ts` — new/updated tests.
