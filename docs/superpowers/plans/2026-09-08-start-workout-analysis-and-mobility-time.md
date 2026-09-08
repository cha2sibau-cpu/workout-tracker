# Start-Workout Analysis, Single-Voice Supersets & Mobility Time — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the relabeled "Start workout" analysis the single, log- and time-aware authority on exercise order/supersets, apply an agreed plan in place so the main workout block reorders itself, silence the coach on supersets, and capture mobility-day time as two summed inputs.

**Architecture:** Backend prompt logic lives in `supabase/functions/coach/logic.ts` (pure, Deno-tested). The `suggest-sequence` edge function fetches session history (like `coach/index.ts` does) and feeds trend/last-session/duration summaries into `buildSequencePrompt`. The single-file frontend `index.html` renders the Today workout; applying a suggestion stores an `appliedOrder` + `appliedSupersets` in the per-day draft and the render loop iterates that order while keeping every input keyed to each exercise's original index.

**Tech Stack:** Deno (edge functions + tests), vanilla JS in `index.html`, Supabase.

## Global Constraints

- Edge functions run on Deno; tests run with `deno test supabase/functions/coach/logic.test.ts`.
- `suggest-sequence` response shape MUST stay `{ sequence, supersets, summary }` — the frontend panel depends on it.
- Every workout input id/handler stays bound to each exercise's **original index** (`ei`); reordering only changes display order, never the keys. (See `index.html:1129` comment.)
- Start workout is advisory-only: the stored program (`WORKOUTS`) is never mutated; applied order lives only in the per-day draft.
- Frontend has no test harness; frontend tasks are verified manually in the browser + by diff review. Backend logic is TDD.
- Model id for Claude calls stays `claude-sonnet-5` (unchanged).

---

### Task 1: `summarizeDurations` helper + `SessionData.durationMin`

**Files:**
- Modify: `supabase/functions/coach/logic.ts` (add `durationMin?` to `SessionData`; add `summarizeDurations`)
- Test: `supabase/functions/coach/logic.test.ts`

**Interfaces:**
- Produces: `summarizeDurations(sessions: SessionData[], dayType: string): string`
- Consumes: existing `SessionData` interface.

- [ ] **Step 1: Write the failing tests**

Add to `supabase/functions/coach/logic.test.ts` (import `summarizeDurations` in the existing import block from `./logic.ts`):

```ts
Deno.test("summarizeDurations reports same-type and overall averages", () => {
  const sessions = [
    { date: "2026-01-06", dayType: "Push", durationMin: 55, exercises: [] },
    { date: "2026-01-04", dayType: "Push", durationMin: 61, exercises: [] },
    { date: "2026-01-02", dayType: "Pull", durationMin: 40, exercises: [] },
  ];
  const out = summarizeDurations(sessions, "Push");
  assertStringIncludes(out, "Push");
  assertStringIncludes(out, "55");
  assertStringIncludes(out, "61");
  assertStringIncludes(out, "avg 58"); // (55+61)/2 = 58
});

Deno.test("summarizeDurations falls back when no durations logged", () => {
  const sessions = [{ date: "2026-01-06", dayType: "Push", exercises: [] }];
  assertEquals(summarizeDurations(sessions, "Push"), "No session times logged yet.");
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `deno test supabase/functions/coach/logic.test.ts`
Expected: FAIL — `summarizeDurations` is not exported / not a function.

- [ ] **Step 3: Implement**

In `supabase/functions/coach/logic.ts`, extend the interface:

```ts
export interface SessionData { date: string; dayType?: string; durationMin?: number; exercises: ExerciseEntry[]; }
```

Add the helper (place it just after `summarizeLastSameTypeSession`):

```ts
// Compact summary of recent session durations — the signal that tells the
// sequencer whether time pressure justifies supersets. Reports this day type's
// recent times plus an overall average, or a fallback when none are logged.
export function summarizeDurations(sessions: SessionData[], dayType: string): string {
  const withTime = sessions.filter((s) => typeof s.durationMin === "number" && s.durationMin! > 0);
  if (!withTime.length) return "No session times logged yet.";

  const avg = (ns: number[]) => Math.round(ns.reduce((a, b) => a + b, 0) / ns.length);

  const sameType = withTime
    .filter((s) => (s.dayType || "") === dayType)
    .sort((a, b) => b.date.localeCompare(a.date))
    .slice(0, 5);
  const overall = withTime.slice(0, 10).map((s) => s.durationMin!);

  const parts: string[] = [];
  if (sameType.length) {
    const mins = sameType.map((s) => s.durationMin!);
    parts.push(`This day type (${dayType}): ${mins.join(", ")} min (avg ${avg(mins)}).`);
  }
  parts.push(`All days: avg ${avg(overall)} min over last ${overall.length}.`);
  return `Recent session times — ${parts.join(" ")}`;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `deno test supabase/functions/coach/logic.test.ts`
Expected: PASS (17 passed).

- [ ] **Step 5: Commit**

```bash
git add supabase/functions/coach/logic.ts supabase/functions/coach/logic.test.ts
git commit -m "Add summarizeDurations helper and SessionData.durationMin"
```

---

### Task 2: Log- & time-aware `buildSequencePrompt`

**Files:**
- Modify: `supabase/functions/coach/logic.ts` (`buildSequencePrompt`)
- Test: `supabase/functions/coach/logic.test.ts` (update existing test + add one)

**Interfaces:**
- Produces: `buildSequencePrompt(params: { phase; weekNum; dayType; isDeload; exercises: ProgramExercise[]; trendSummary: string; lastSameTypeSummary: string; durationSummary: string }): string`
- Consumes: `summarizeDurations` (Task 1), existing `computeTrendSummary`, `summarizeLastSameTypeSession`.

- [ ] **Step 1: Update the existing test and add a new one**

Replace the existing `buildSequencePrompt` test (currently `logic.test.ts:94-106`) with:

```ts
Deno.test("buildSequencePrompt lists exercises in order and asks for supersets", () => {
  const prompt = buildSequencePrompt({
    phase: 3, weekNum: 15, dayType: "Push", isDeload: false,
    exercises: [
      { name: "DB bench press", targetReps: "12", sets: 4 },
      { name: "Overhead DB press", targetReps: "10", sets: 4, warning: "RPE cap: 7 always" },
    ],
    trendSummary: "DB bench press: 18kg -> 22kg, trend up",
    lastSameTypeSummary: "Last Push session (2026-01-04): DB bench press: 22kg×8 @RPE8",
    durationSummary: "Recent session times — This day type (Push): 58, 61 min (avg 60). All days: avg 52 min over last 8.",
  });
  assertStringIncludes(prompt, "1. DB bench press — target 12 reps — 4 sets");
  assertStringIncludes(prompt, "⚠ RPE cap: 7 always");
  assertStringIncludes(prompt, "superset");
  assertStringIncludes(prompt, "6-month, 4-phase periodisation program");
});

Deno.test("buildSequencePrompt grounds the decision in logs, time, and RPE", () => {
  const prompt = buildSequencePrompt({
    phase: 2, weekNum: 8, dayType: "Push", isDeload: false,
    exercises: [{ name: "DB bench press", targetReps: "12", sets: 3 }],
    trendSummary: "DB bench press: 18kg -> 22kg, trend up",
    lastSameTypeSummary: "Last Push session (2026-01-04): DB bench press: 22kg×8 @RPE8",
    durationSummary: "Recent session times — This day type (Push): 58, 61 min (avg 60). All days: avg 52 min over last 8.",
  });
  assertStringIncludes(prompt, "DB bench press: 18kg -> 22kg, trend up");
  assertStringIncludes(prompt, "Last Push session (2026-01-04)");
  assertStringIncludes(prompt, "avg 60");
  assertStringIncludes(prompt, "saving time"); // time-first superset rationale
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `deno test supabase/functions/coach/logic.test.ts`
Expected: FAIL — new params not in signature / `saving time` and history blocks not in prompt.

- [ ] **Step 3: Implement the new prompt**

Replace `buildSequencePrompt` in `supabase/functions/coach/logic.ts` with:

```ts
// Prompt for the dedicated "Start workout" button. Returns a structured
// recommendation (via the caller's JSON schema) rather than prose. Grounded in
// the lifter's real logs, recent RPE trend, and how long recent sessions ran —
// because saving time is the main reason to superset.
export function buildSequencePrompt(params: {
  phase: number;
  weekNum: number;
  dayType: string;
  isDeload: boolean;
  exercises: ProgramExercise[];
  trendSummary: string;
  lastSameTypeSummary: string;
  durationSummary: string;
}): string {
  const { phase, weekNum, dayType, isDeload, exercises, trendSummary, lastSameTypeSummary, durationSummary } = params;

  return [
    `You are a strength coach optimizing the exercise order for a lifter's workout today and identifying safe, effective superset pairings. You are the single source of truth for order and supersets — base your decision on their real logs and time spent, not just textbook rules.`,
    ``,
    PLAN_RULES,
    ``,
    `Current state: Phase ${phase}, Week ${weekNum}, today's day type: ${dayType}.${isDeload ? " This is a mandatory deload week — keep intensity conservative." : ""}`,
    ``,
    `The exercises currently planned today, in their current order:`,
    formatExerciseList(exercises),
    ``,
    `Recent progress across exercises:`,
    trendSummary,
    ``,
    `Previous same-type session:`,
    lastSameTypeSummary,
    ``,
    `Time spent recently:`,
    durationSummary,
    ``,
    `Recommend the best order: compound/heaviest and most technical lifts first, isolation work last, managing fatigue and respecting the RPE ceilings above. Then decide on supersets. Saving time is the main reason to superset: if recent sessions of this day type are running long, lean toward pairing non-competing or agonist/antagonist / isolation work to cut time without compromising the key lifts. If sessions are already short, or recent RPE is drifting high (fatigue/recovery risk), be conservative — recommend fewer or no supersets. Return an empty supersets list if none are advisable today.`,
    ``,
    `Use only the exercise names exactly as given. "sequence" must list every exercise today in the recommended order, each with a one-line reason. For each superset, list the exercise names and a one-line reason. "summary" is one or two sentences of overall guidance that references the time reasoning (e.g. recent average duration and the time you expect the supersets to save).`,
  ].join("\n");
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `deno test supabase/functions/coach/logic.test.ts`
Expected: PASS (18 passed).

- [ ] **Step 5: Commit**

```bash
git add supabase/functions/coach/logic.ts supabase/functions/coach/logic.test.ts
git commit -m "Make buildSequencePrompt log- and time-aware"
```

---

### Task 3: Coach defers on supersets

**Files:**
- Modify: `supabase/functions/coach/logic.ts` (`buildCoachPrompt`)
- Test: `supabase/functions/coach/logic.test.ts`

**Interfaces:**
- No signature change to `buildCoachPrompt`.

- [ ] **Step 1: Write the failing test**

Add to `logic.test.ts`:

```ts
Deno.test("buildCoachPrompt defers order/supersets to the Start workout analysis", () => {
  const prompt = buildCoachPrompt({
    phase: 1, weekNum: 2, dayType: "Push", isDeload: false,
    trendSummary: "n/a", recentMessages: [], newMessage: "What order should I do today?",
  });
  // No longer offers to prescribe sequencing/supersets itself…
  assertEquals(prompt.includes("advise on exercise sequencing and supersets"), false);
  // …and points the lifter at the Start workout analysis instead.
  assertStringIncludes(prompt, "Start workout");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `deno test supabase/functions/coach/logic.test.ts`
Expected: FAIL — old clause still present, "Start workout" absent.

- [ ] **Step 3: Implement**

In `buildCoachPrompt`, replace the first array line (currently `index.html`-independent, at `logic.ts:109`):

```ts
    `You are a strength coach for a lifter following a structured long-term program. Act as their personal trainer across the whole program, not just one exercise. You can see their full schedule and today's exercises in order, so you can advise on exercise sequencing and supersets when relevant.`,
```

with:

```ts
    `You are a strength coach for a lifter following a structured long-term program. Act as their personal trainer across the whole program, not just one exercise. You can see their full schedule and today's exercises in order. Exercise order and supersets are decided by the app's "Start workout" analysis, which is grounded in their logs and time spent — do not invent your own ordering or pairings; if they ask about order or supersets, point them to the Start workout button. Focus your advice on load, progression, recovery, RPE, and form.`,
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `deno test supabase/functions/coach/logic.test.ts`
Expected: PASS (19 passed). The existing test "buildCoachPrompt includes the program schedule and today's ordered exercises" still passes (program context is unchanged).

- [ ] **Step 5: Commit**

```bash
git add supabase/functions/coach/logic.ts supabase/functions/coach/logic.test.ts
git commit -m "Coach defers exercise order/supersets to Start workout analysis"
```

---

### Task 4: `suggest-sequence` fetches history and passes summaries

**Files:**
- Modify: `supabase/functions/suggest-sequence/index.ts`

**Interfaces:**
- Consumes: `buildSequencePrompt` (Task 2), `computeTrendSummary`, `summarizeLastSameTypeSession`, `summarizeDurations` (Task 1), `SessionData`.

- [ ] **Step 1: Update imports**

Change the import at `supabase/functions/suggest-sequence/index.ts:9` to:

```ts
import {
  buildSequencePrompt,
  computeTrendSummary,
  summarizeDurations,
  summarizeLastSameTypeSession,
  type ProgramExercise,
  type SessionData,
} from "../coach/logic.ts";
```

- [ ] **Step 2: Fetch sessions and compute summaries before building the prompt**

Replace the prompt construction (currently `index.ts:91-97`) with:

```ts
  const { data: sessionRows, error: sessErr } = await supabase
    .from("sessions")
    .select("data")
    .order("date", { ascending: false })
    .limit(40);
  if (sessErr) return jsonResponse({ error: sessErr.message }, 500);

  const sessions = (sessionRows ?? []).map((r) => r.data as SessionData);
  const dayType = body.dayType ?? "";

  const prompt = buildSequencePrompt({
    phase: body.phase ?? 1,
    weekNum: body.weekNum ?? 1,
    dayType,
    isDeload: !!body.isDeload,
    exercises,
    trendSummary: computeTrendSummary(sessions),
    lastSameTypeSummary: summarizeLastSameTypeSession(sessions, dayType),
    durationSummary: summarizeDurations(sessions, dayType),
  });
```

- [ ] **Step 3: Type-check the function**

Run: `deno check supabase/functions/suggest-sequence/index.ts`
Expected: no type errors. (The `sessions` table is read exactly as `coach/index.ts:53-58` does, so the auth/client pattern is already correct.)

- [ ] **Step 4: Commit**

```bash
git add supabase/functions/suggest-sequence/index.ts
git commit -m "suggest-sequence: feed trend, last session, and time into the prompt"
```

---

### Task 5: Rename button to "Start workout" + loading copy

**Files:**
- Modify: `index.html` (button at `:1219`, loading text at `:1469`)

- [ ] **Step 1: Rename the button**

Replace `index.html:1219`:

```html
      <button class="btn btn-outline btn-sm" id="seq-btn" style="width:100%;margin-bottom:8px" onclick="suggestSequence('${dtSafe}',${phase},${weekNum})">🔀 Suggest order / supersets</button>
```

with:

```html
      <button class="btn btn-outline btn-sm" id="seq-btn" style="width:100%;margin-bottom:8px" onclick="suggestSequence('${dtSafe}',${phase},${weekNum})">▶ Start workout</button>
```

- [ ] **Step 2: Update the loading text**

Replace `index.html:1469`:

```js
  panel.innerHTML = `<div class="seq-card seq-loading">🤖 Claude is optimizing your order…</div>`;
```

with:

```js
  panel.innerHTML = `<div class="seq-card seq-loading">🤖 Claude is analyzing your logs…</div>`;
```

- [ ] **Step 3: Verify in the browser**

Open the app (Today tab, a strength day). Confirm the button reads "▶ Start workout" and pressing it shows "Claude is analyzing your logs…".

- [ ] **Step 4: Commit**

```bash
git add index.html
git commit -m "Rename Suggest order/supersets button to Start workout"
```

---

### Task 6: Apply the plan in place — reorder + supersets, collapsed panel

**Files:**
- Modify: `index.html` — render loop (`:1185-1216`), `renderSequence` (`:1502-1533`), `applySupersets`→`applyPlan` (`:1545-1573`), `ungroupSupersets`/`ungroupSupersets2` (`:1576-1586`), in-frame Ungroup button (`:1193-1195`).

**Interfaces:**
- Produces: `draft[dKey].appliedOrder: number[]` (original indices, full length), `applyPlan(dKey)`, `undoPlan(date, dayType)`, `undoPlan2(dKey)`, `toggleSeqReview(dKey)`.
- Consumes: existing `getDraft`/`saveDraft`, `findExerciseIndex`, `getPhaseExercises`, `getCycleInfo`, `renderToday`, `paintSeqPanel`.

- [ ] **Step 1: Build `appliedOrder` + groups when applying (rename `applySupersets`)**

Replace `applySupersets` (`index.html:1545-1573`) with:

```js
// Apply Claude's plan: build the reordered exercise list (original indices) and
// the superset groups, store both in the day draft, and re-render so the main
// Exercises block reflects the plan in place. Names are matched to original
// indices; any exercise Claude didn't mention is appended in its original order
// so nothing is ever dropped.
function applyPlan(dKey) {
  const parts   = dKey.split('|');
  const date    = parts[0], dayType = parts.slice(1).join('|');
  const draft   = getDraft();
  const data    = draft[dKey] && draft[dKey].seq;
  if (!data) return;
  const info    = getCycleInfo(date);
  const phase   = info ? info.phase : 1;
  const workout = getPhaseExercises(dayType, phase);
  if (!workout || !workout.exercises) return;
  const exs = workout.exercises;

  // Order: map sequence names → original indices, then append any missing.
  const order = [];
  const inOrder = {};
  (Array.isArray(data.sequence) ? data.sequence : []).forEach(s => {
    const i = findExerciseIndex(exs, s && s.name);
    if (i >= 0 && !inOrder[i]) { order.push(i); inOrder[i] = true; }
  });
  exs.forEach((_, i) => { if (!inOrder[i]) order.push(i); });

  // Supersets: map each suggested pair → original indices (>=2 members).
  const seen = {};
  const groups = [];
  (Array.isArray(data.supersets) ? data.supersets : []).forEach(ss => {
    const names = Array.isArray(ss.exercises) ? ss.exercises : [];
    const idxs = [];
    names.forEach(nm => {
      const i = findExerciseIndex(exs, nm);
      if (i >= 0 && !seen[i]) { idxs.push(i); seen[i] = true; }
    });
    if (idxs.length >= 2) groups.push(idxs);
  });

  if (!draft[dKey]) draft[dKey] = {};
  draft[dKey].appliedOrder = order;
  draft[dKey].appliedSupersets = groups; // may be empty — order still applies
  saveDraft(draft);
  renderToday();
}

// Clear an applied plan and restore the program's original order.
function undoPlan(date, dayType) {
  const dKey  = date + '|' + dayType;
  const draft = getDraft();
  if (draft[dKey]) {
    delete draft[dKey].appliedOrder;
    delete draft[dKey].appliedSupersets;
    saveDraft(draft);
  }
  renderToday();
}
function undoPlan2(dKey) {
  const parts = dKey.split('|');
  undoPlan(parts[0], parts.slice(1).join('|'));
}

// Expand/collapse the applied-plan review in the seq panel.
function toggleSeqReview(dKey) {
  const draft = getDraft();
  if (!draft[dKey]) draft[dKey] = {};
  draft[dKey].seqOpen = !draft[dKey].seqOpen;
  saveDraft(draft);
  paintSeqPanel(dKey);
}
```

Delete the now-replaced `ungroupSupersets` and `ungroupSupersets2` functions (`index.html:1576-1586`).

- [ ] **Step 2: Reorder the render loop by `appliedOrder`**

In `renderToday`, replace the exercises iteration (`index.html:1185-1215`, from `const emitted = {};` through the closing of the `forEach`) with:

```js
    const emitted = {};
    let firstRow = true;
    const order = Array.isArray(draftDay.appliedOrder) && draftDay.appliedOrder.length
      ? draftDay.appliedOrder
      : workout.exercises.map((_, i) => i);
    order.forEach((ei) => {
      if (ei < 0 || ei >= workout.exercises.length) return;
      if (emitted[ei]) return;
      const ex = workout.exercises[ei];
      const g = groupOf[ei];
      if (g && g[0] === ei) {
        // Group leader → emit the whole group adjacent here (at the leader's
        // slot in the applied order). Non-leader members are skipped below.
        if (applied) {
          h += `<div class="superset-applied"><div class="superset-tag">🔗 Superset — perform back-to-back</div>`;
        } else {
          h += `<div class="superset-wrap"><div class="superset-tag">🔗 Superset — perform back-to-back</div>`;
        }
        g.forEach((gi, k) => {
          if (gi < 0 || gi >= workout.exercises.length) return;
          if (k > 0) h += `<div class="ex-divider"></div>`;
          h += renderEx(workout.exercises[gi], gi);
          emitted[gi] = true;
        });
        h += `</div>`;
        firstRow = false;
      } else if (g) {
        return; // other members emitted with the group leader
      } else {
        if (!firstRow) h += `<div class="ex-divider"></div>`;
        h += renderEx(ex, ei);
        emitted[ei] = true;
        firstRow = false;
      }
    });
```

Note: the in-frame **Ungroup** button is removed (undo now lives in the collapsed panel — Step 3). The superset block renders at its leader's (`g[0]`) slot in `appliedOrder`; non-leader members are skipped where they fall and emitted adjacent inside the leader's frame. Every index appears in `appliedOrder` (missing ones were appended in Step 1), so a leader is always reached and no exercise is dropped.

- [ ] **Step 3: Collapse the panel to an applied/undo summary**

Replace `renderSequence` (`index.html:1502-1533`) with:

```js
function renderSequence(data, dKey) {
  const seq    = Array.isArray(data.sequence) ? data.sequence : [];
  const supers = Array.isArray(data.supersets) ? data.supersets : [];
  const dd     = getDraft()[dKey] || {};
  const applied = Array.isArray(dd.appliedOrder) && dd.appliedOrder.length > 0;
  const dKeyJs = dKey.replace(/'/g, "\\'");

  // Applied + collapsed → one-line summary the user doesn't have to scroll past.
  if (applied && !dd.seqOpen) {
    return `<div class="seq-card"><button class="btn-use-ss applied" onclick="toggleSeqReview('${dKeyJs}')">✓ Plan applied — tap to review / undo</button></div>`;
  }

  let h = `<div class="seq-card">`;
  if (data.summary) h += `<div class="seq-summary">${esc(data.summary)}</div>`;
  if (seq.length) {
    h += `<div class="seq-h">Suggested order</div><ol class="seq-list">`;
    seq.forEach(s => {
      h += `<li><span class="seq-name">${esc(s.name)}</span>${s.reason ? `<span class="seq-reason">${esc(s.reason)}</span>` : ''}</li>`;
    });
    h += `</ol>`;
  }
  if (supers.length) {
    h += `<div class="seq-h">Supersets</div>`;
    supers.forEach(ss => {
      const names = Array.isArray(ss.exercises) ? ss.exercises.map(esc).join(' + ') : '';
      h += `<div class="seq-superset"><span class="seq-name">${names}</span>${ss.reason ? `<span class="seq-reason">${esc(ss.reason)}</span>` : ''}</div>`;
    });
  } else {
    h += `<div class="seq-reason" style="margin-top:6px">No supersets recommended today.</div>`;
  }
  if (applied) {
    h += `<button class="btn-use-ss" onclick="undoPlan2('${dKeyJs}')">Undo — restore original order</button>`;
    h += `<button class="btn-use-ss applied" onclick="toggleSeqReview('${dKeyJs}')">Collapse ▴</button>`;
  } else {
    h += `<button class="btn-use-ss" onclick="applyPlan('${dKeyJs}')">Use this plan ✓</button>`;
  }
  h += `<div class="seq-foot">Advisory only — your program isn't changed.</div></div>`;
  return h;
}
```

- [ ] **Step 4: Verify in the browser**

Open the app on a strength day with logged history. Press **▶ Start workout**. When the suggestion appears, press **Use this plan ✓**. Confirm:
  - the main Exercises block reorders to the suggested order and supersets render in the teal applied frame;
  - the panel collapses to `✓ Plan applied — tap to review / undo`;
  - tapping it expands the order/supersets with an **Undo** button; Undo restores the original order and shows **Use this plan ✓** again;
  - switching tabs and returning keeps the applied order (draft persistence);
  - all kg/reps/RPE inputs still hold their values after reorder (original-index keying).

- [ ] **Step 5: Commit**

```bash
git add index.html
git commit -m "Apply Start-workout plan in place: reorder + supersets, collapsed panel"
```

---

### Task 7: Mobility A & B — two time inputs summed on complete

**Files:**
- Modify: `index.html` — checklist branch (`:1104`), new `mobilityTimeFieldsHtml` + handler near `totalTimeFieldHtml` (`:1256-1272`), `markCompleteMobility` (`:1659-1679`), `markComplete` (`:1746-1771`).

**Interfaces:**
- Produces: `mobilityTimeFieldsHtml(date, dayType, draftDay)`, `upMobTime(date, dayType, field, val)` where `field` is `'walkMin'|'otherMin'`; `markComplete(date, dayType, exercises, timeOverride?)`.

- [ ] **Step 1: Add the two-field renderer + handler**

Insert after `upTotalTime` (`index.html:1272`):

```js
// Mobility days capture time as indoor walking (may be blank/0) + mobility work.
// Both persist in the day draft; markCompleteMobility sums them into durationMin.
function mobilityTimeFieldsHtml(date, dayType, draftDay) {
  const dtJs = dayType.replace(/'/g, "\\'");
  const walk = (draftDay && draftDay.walkMin) || '';
  const other = (draftDay && draftDay.otherMin) || '';
  return `<div class="total-time-row">
      <label for="walk-min-inp">🚶 Indoor walking (min)</label>
      <input type="number" inputmode="numeric" min="0" id="walk-min-inp" class="total-time-inp"
        placeholder="0" value="${esc(walk)}"
        oninput="upMobTime('${date}','${dtJs}','walkMin',this.value)">
    </div>
    <div class="total-time-row">
      <label for="other-min-inp">🧘 Mobility work (min)</label>
      <input type="number" inputmode="numeric" min="0" id="other-min-inp" class="total-time-inp"
        placeholder="e.g. 20" value="${esc(other)}"
        oninput="upMobTime('${date}','${dtJs}','otherMin',this.value)">
    </div>`;
}

function upMobTime(date, dayType, field, val) {
  const draft = getDraft();
  const dKey  = date + '|' + dayType;
  if (!draft[dKey]) draft[dKey] = {};
  draft[dKey][field] = val;
  saveDraft(draft);
}
```

- [ ] **Step 2: Use the two-field renderer on mobility days**

Replace `index.html:1104`:

```js
    h += totalTimeFieldHtml(today, dayType, draftDay);
```

(inside the `else if (workout.checklistOnly)` branch only — the one immediately before the `markCompleteMobility` button) with:

```js
    h += mobilityTimeFieldsHtml(today, dayType, draftDay);
```

Leave the identical `totalTimeFieldHtml` call in the strength branch (`index.html:1226`) unchanged.

- [ ] **Step 3: Sum the two inputs on completion**

Replace the end of `markCompleteMobility` (`index.html:1678`):

```js
  markComplete(date, dayType, exercises);
```

with:

```js
  const w = parseInt(draftDay.walkMin, 10);
  const o = parseInt(draftDay.otherMin, 10);
  const walk = Number.isFinite(w) && w > 0 ? w : 0;
  const other = Number.isFinite(o) && o > 0 ? o : 0;
  markComplete(date, dayType, exercises, { walkMin: walk, otherMin: other, totalMin: walk + other });
```

- [ ] **Step 4: Accept a time override in `markComplete`**

Replace the signature and time block of `markComplete` (`index.html:1746` and `:1753-1756`).

Change the signature line:

```js
function markComplete(date, dayType, exercises) {
```

to:

```js
function markComplete(date, dayType, exercises, timeOverride) {
```

Replace the duration block (`index.html:1753-1756`):

```js
  // Total workout time (manual entry), if provided — read before the draft is cleared.
  const rawMin = (getDraft()[date + '|' + dayType] || {}).totalMin;
  const durationMin = parseInt(rawMin, 10);
  if (Number.isFinite(durationMin) && durationMin > 0) session.durationMin = durationMin;
```

with:

```js
  // Total workout time. Mobility days pass a summed override (walk + mobility
  // work) and keep the split on the session; strength days read the single field.
  if (timeOverride) {
    if (timeOverride.totalMin > 0) session.durationMin = timeOverride.totalMin;
    session.walkMin = timeOverride.walkMin;
    session.otherMin = timeOverride.otherMin;
  } else {
    const rawMin = (getDraft()[date + '|' + dayType] || {}).totalMin;
    const durationMin = parseInt(rawMin, 10);
    if (Number.isFinite(durationMin) && durationMin > 0) session.durationMin = durationMin;
  }
```

- [ ] **Step 5: Verify in the browser**

Open a Mobility A day. Confirm two inputs (🚶 Indoor walking, 🧘 Mobility work). Enter walking = blank, mobility = 20 → Mark Complete → Log shows the session with `⏱ 20 min`. Repeat with walking = 15, mobility = 20 → total 35 min. Confirm a strength day still shows the single "Total time (min)" field and records correctly.

- [ ] **Step 6: Commit**

```bash
git add index.html
git commit -m "Mobility days: split time into walking + mobility work, summed on complete"
```

---

## Self-Review Notes

- **Spec coverage:** Part 1 (log/time-aware analysis) → Tasks 1,2,4. Part 1b (apply in place, reorder+supersets, collapse) → Task 6. Part 2 (coach defers) → Task 3. Part 3 (mobility two inputs, sum, store split) → Task 7. Button rename/loading copy → Task 5.
- **Response-shape constraint:** `suggest-sequence` still returns `{ sequence, supersets, summary }` (Task 4 changes only prompt inputs), so the panel is unaffected.
- **Original-index keying:** Task 6 iterates `appliedOrder` but always calls `renderEx(workout.exercises[ei], ei)` with the original index — inputs never desync.
- **No exercise dropped:** Task 6 appends any unmentioned index to `appliedOrder`.
- **Type consistency:** `applyPlan`/`undoPlan`/`undoPlan2`/`toggleSeqReview`/`upMobTime`/`mobilityTimeFieldsHtml` are defined in the tasks that reference them; `summarizeDurations` (Task 1) matches its use in Task 4; `buildSequencePrompt`'s new required params (Task 2) match the call site (Task 4).
