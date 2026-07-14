# Coach Chat Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the narrow per-exercise "Ask Claude" button with a persistent, holistic "Coach" chat that understands the whole periodization program (phase, deload state, RPE ceilings) and every exercise's trend — while keeping the cost of every question bounded regardless of how long the app has been used.

**Architecture:** A new Supabase table (`chat_messages`) stores one continuous, ever-growing conversation per user. A new Edge Function (`coach`, replacing `ask-claude`) assembles a *bounded* context on every request — static plan rules, current phase/deload state, a compact per-exercise trend summary, and only the last ~20 messages of the stored thread — then calls Claude and persists both sides of the exchange. Two frontend entry points (a new Coach tab, and the existing per-exercise button repurposed as a shortcut) both funnel into the same send-message flow and the same thread.

**Tech Stack:** Same as the existing Supabase + Claude integration — Supabase (Postgres + Auth + Edge Functions), Deno + its test runner, Anthropic Messages API (`claude-sonnet-5`), plain inline JS/HTML/CSS in `index.html` (no build step, no new frontend framework).

## Global Constraints

- No build step / bundler for the frontend — all frontend code stays inline in `index.html`.
- No new frontend test framework — frontend changes are verified manually in a browser, matching the existing app's convention. Only the Edge Function's pure logic gets automated tests, via Deno's test runner.
- Single user — RLS policies are "row belongs to `auth.uid()`", not multi-tenant.
- Never commit secrets. `ANTHROPIC_API_KEY` is already set as a Supabase secret from the prior work — this plan does not need a new one.
- **Every migration in this plan must include its GRANT statements in the same file as its CREATE TABLE/policies** — a prior migration shipped without them and had to be patched after the fact; do not repeat that.
- Design spec for this feature: `docs/superpowers/specs/2026-07-14-coach-chat-design.md` — read it for full rationale; this plan implements it.

---

### Task 1: `chat_messages` schema

**Files:**
- Create: `supabase/migrations/0003_chat_messages.sql`

**Interfaces:**
- Produces: table `public.chat_messages(id uuid, user_id uuid, role text, content text, created_at timestamptz)`. Task 2's Edge Function reads/writes this table directly.

- [ ] **Step 1: Write the migration**

```sql
-- supabase/migrations/0003_chat_messages.sql

create table public.chat_messages (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) default auth.uid(),
  role text not null check (role in ('user','assistant')),
  content text not null,
  created_at timestamptz not null default now()
);

alter table public.chat_messages enable row level security;

create policy "chat_messages_select_own" on public.chat_messages
  for select using (auth.uid() = user_id);
create policy "chat_messages_insert_own" on public.chat_messages
  for insert with check (auth.uid() = user_id);
create policy "chat_messages_delete_own" on public.chat_messages
  for delete using (auth.uid() = user_id);

grant select, insert, delete on public.chat_messages to authenticated;
```

- [ ] **Step 2: Verify locally against a real Postgres instance**

```bash
supabase start
supabase db reset
```

(If containers already exist from prior work, `supabase start` just brings them back up — no fresh image pulls needed. If this is a first run in a new environment, budget several minutes for image pulls.) Then inspect:

```bash
docker exec supabase_db_$(basename "$(pwd)") psql -U postgres -c "\d public.chat_messages"
docker exec supabase_db_$(basename "$(pwd)") psql -U postgres -c "\dp public.chat_messages"
docker exec supabase_db_$(basename "$(pwd)") psql -U postgres -c "select policyname, cmd from pg_policies where tablename = 'chat_messages';"
```

Expected: table has the 4 columns above; `\dp` shows `authenticated=arwd...` (select/insert/delete present, not just the default truncate/references/trigger/maintain); exactly 3 policies (`chat_messages_select_own`/SELECT, `chat_messages_insert_own`/INSERT, `chat_messages_delete_own`/DELETE).

Run `supabase stop` when done.

- [ ] **Step 3: Commit**

```bash
git add supabase/migrations/0003_chat_messages.sql
git commit -m "Add chat_messages schema with RLS and grants"
```

---

### Task 2: `coach` Edge Function

**Files:**
- Create: `supabase/functions/coach/logic.ts`
- Create: `supabase/functions/coach/logic.test.ts`
- Create: `supabase/functions/coach/index.ts`

**Interfaces:**
- Produces: deployed function at `POST {SUPABASE_URL}/functions/v1/coach`, request body `{ message: string, phase: number, weekNum: number, dayType: string, isDeload: boolean }`, response `{ reply: string }` on 200, `{ error: string }` on 4xx/5xx. Task 3's frontend calls this exact shape.

- [ ] **Step 1: Write the pure logic module**

```ts
// supabase/functions/coach/logic.ts

export interface SetEntry { kg?: string; reps?: string; rpe?: string; note?: string; }
export interface ExerciseEntry { name: string; sets: SetEntry[]; }
export interface SessionData { date: string; dayType?: string; exercises: ExerciseEntry[]; }
export interface ChatMessage { role: "user" | "assistant"; content: string; }

// A compact, roughly-constant-size summary — one line per exercise that has
// history — rather than raw per-set data for every session ever logged.
// This is what keeps the Claude request bounded regardless of how many
// months of sessions exist: the number of distinct exercises in the
// program is fixed (~20), it doesn't grow with time.
export function computeTrendSummary(sessions: SessionData[]): string {
  const byExercise = new Map<string, { date: string; kg: number; reps: string; rpe: string }[]>();

  for (const session of sessions) {
    for (const ex of session.exercises || []) {
      const filled = (ex.sets || []).filter((s) => s.kg && parseFloat(s.kg) > 0);
      if (!filled.length) continue;
      const last = filled[filled.length - 1];
      const list = byExercise.get(ex.name) || [];
      list.push({ date: session.date, kg: parseFloat(last.kg!), reps: last.reps || "?", rpe: last.rpe || "?" });
      byExercise.set(ex.name, list);
    }
  }

  const lines: string[] = [];
  for (const [name, entries] of byExercise) {
    entries.sort((a, b) => a.date.localeCompare(b.date));
    const first = entries[0];
    const latest = entries[entries.length - 1];
    const direction = latest.kg > first.kg ? "up" : latest.kg < first.kg ? "down" : "flat";
    lines.push(
      `${name}: ${first.kg}kg (${first.date}) -> ${latest.kg}kg (${latest.date}), trend ${direction}, latest ${latest.reps} reps @ RPE ${latest.rpe}`
    );
  }
  return lines.length ? lines.join("\n") : "No exercise history logged yet.";
}

const PLAN_RULES = `This is a 6-month, 4-phase periodisation program, 7-day rotating cycle (Pull, Mobility A, Lower/Core, Mobility B, Push, Rest, Push):
- Phase 1 (weeks 1-6): Structural base. 3 sets/exercise. RPE target 7-8. Focus: form, joint prep.
- Phase 2 (weeks 7-13): Strength accumulation. Add 1 set to main compounds. RPE target 8 for main lifts.
- Phase 3 (weeks 14-20): Strength peak. 4 sets across all main exercises. RPE target 8-8.5.
- Phase 4 (weeks 21-26): Deload + reset. Weeks 21-22: 60% of Phase 3 weights, 2 sets only (mandatory deload, non-optional). Weeks 23-26: reassess and plan next block.
- Hard ceilings, never exceed regardless of phase: Overhead DB press RPE 7. Bulgarian split squat RPE 7.5 (stop if knee tracks inward).`;

export function buildCoachPrompt(params: {
  phase: number;
  weekNum: number;
  dayType: string;
  isDeload: boolean;
  trendSummary: string;
  recentMessages: ChatMessage[];
  newMessage: string;
}): string {
  const { phase, weekNum, dayType, isDeload, trendSummary, recentMessages, newMessage } = params;

  const history = recentMessages
    .map((m) => `${m.role === "user" ? "Lifter" : "Coach"}: ${m.content}`)
    .join("\n");

  return [
    `You are a strength coach for a lifter following a structured long-term program. Act as their personal trainer across the whole program, not just one exercise.`,
    ``,
    PLAN_RULES,
    ``,
    `Current state: Phase ${phase}, Week ${weekNum}, today's day type: ${dayType}.${isDeload ? " This is a mandatory deload week — do not recommend increasing load." : ""}`,
    ``,
    `Recent progress across exercises:`,
    trendSummary,
    ``,
    history ? `Recent conversation:\n${history}\n` : ``,
    `Guiding principle: this is a multi-year program, not a race. Prioritize long-term, sustainable progress and injury prevention over fast short-term gains. Be conservative about recommending weight or rep increases, and explicitly flag anything that looks like too-rapid a load increase.`,
    ``,
    `Lifter: ${newMessage}`,
    ``,
    `Reply conversationally as their coach, in a few sentences. Do not reply with JSON — plain text only.`,
  ].join("\n");
}
```

- [ ] **Step 2: Write the tests**

```ts
// supabase/functions/coach/logic.test.ts

import { assertEquals, assertStringIncludes } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { buildCoachPrompt, computeTrendSummary } from "./logic.ts";

Deno.test("computeTrendSummary summarizes first-to-latest per exercise", () => {
  const sessions = [
    { date: "2026-01-01", exercises: [{ name: "Lat Pulldown", sets: [{ kg: "15", reps: "12", rpe: "7" }] }] },
    { date: "2026-03-01", exercises: [{ name: "Lat Pulldown", sets: [{ kg: "20", reps: "10", rpe: "8" }] }] },
  ];
  const summary = computeTrendSummary(sessions);
  assertStringIncludes(summary, "Lat Pulldown: 15kg (2026-01-01) -> 20kg (2026-03-01)");
  assertStringIncludes(summary, "trend up");
});

Deno.test("computeTrendSummary handles no history", () => {
  assertEquals(computeTrendSummary([]), "No exercise history logged yet.");
});

Deno.test("computeTrendSummary ignores sets with no weight logged", () => {
  const sessions = [
    { date: "2026-01-01", exercises: [{ name: "Hammer curl", sets: [{ kg: "", reps: "12", rpe: "" }] }] },
  ];
  assertEquals(computeTrendSummary(sessions), "No exercise history logged yet.");
});

Deno.test("buildCoachPrompt includes the deload warning when isDeload is true", () => {
  const prompt = buildCoachPrompt({
    phase: 4, weekNum: 21, dayType: "Push", isDeload: true,
    trendSummary: "n/a", recentMessages: [], newMessage: "Should I add weight to bench?",
  });
  assertStringIncludes(prompt, "mandatory deload week — do not recommend increasing load");
});

Deno.test("buildCoachPrompt omits the deload warning when isDeload is false", () => {
  const prompt = buildCoachPrompt({
    phase: 2, weekNum: 8, dayType: "Push", isDeload: false,
    trendSummary: "n/a", recentMessages: [], newMessage: "How am I doing?",
  });
  assertEquals(prompt.includes("mandatory deload week"), false);
});

Deno.test("buildCoachPrompt includes recent conversation, trend summary, and the safety-first principle", () => {
  const prompt = buildCoachPrompt({
    phase: 1, weekNum: 2, dayType: "Pull", isDeload: false,
    trendSummary: "Lat Pulldown: 15kg -> 20kg, trend up",
    recentMessages: [{ role: "user", content: "I tweaked my shoulder last week" }],
    newMessage: "Can I increase weight on rows?",
  });
  assertStringIncludes(prompt, "Lat Pulldown: 15kg -> 20kg, trend up");
  assertStringIncludes(prompt, "I tweaked my shoulder last week");
  assertStringIncludes(prompt, "Prioritize long-term, sustainable progress");
  assertStringIncludes(prompt, "Can I increase weight on rows?");
});
```

- [ ] **Step 3: Run the tests and confirm all pass**

```bash
deno test supabase/functions/coach/logic.test.ts
```

Expected: `ok | 7 passed | 0 failed`. Fix `logic.ts` if anything fails.

- [ ] **Step 4: Write the HTTP handler**

```ts
// supabase/functions/coach/index.ts

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { buildCoachPrompt, computeTrendSummary, type ChatMessage } from "./logic.ts";

const ANTHROPIC_API_KEY = Deno.env.get("ANTHROPIC_API_KEY")!;
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...CORS_HEADERS },
  });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS_HEADERS });
  if (req.method !== "POST") return jsonResponse({ error: "Method not allowed" }, 405);

  const authHeader = req.headers.get("Authorization");
  if (!authHeader) return jsonResponse({ error: "Missing Authorization header" }, 401);

  const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    global: { headers: { Authorization: authHeader } },
  });

  const { data: userData, error: userErr } = await supabase.auth.getUser();
  if (userErr || !userData.user) return jsonResponse({ error: "Invalid session" }, 401);

  let body: { message?: string; phase?: number; weekNum?: number; dayType?: string; isDeload?: boolean };
  try {
    body = await req.json();
  } catch {
    return jsonResponse({ error: "Invalid JSON body" }, 400);
  }
  const { message, phase, weekNum, dayType, isDeload } = body;
  if (!message || typeof message !== "string") {
    return jsonResponse({ error: "message is required" }, 400);
  }

  const { error: insertUserErr } = await supabase
    .from("chat_messages")
    .insert({ role: "user", content: message });
  if (insertUserErr) return jsonResponse({ error: insertUserErr.message }, 500);

  const { data: sessionRows, error: sessErr } = await supabase
    .from("sessions")
    .select("data")
    .order("date", { ascending: false })
    .limit(40);
  if (sessErr) return jsonResponse({ error: sessErr.message }, 500);

  // Fetch the last 20 messages (newest first, includes the one just
  // inserted above), then drop that just-inserted message so
  // "recent conversation" reflects only what came before it.
  const { data: messageRows, error: msgErr } = await supabase
    .from("chat_messages")
    .select("role, content")
    .order("created_at", { ascending: false })
    .limit(20);
  if (msgErr) return jsonResponse({ error: msgErr.message }, 500);

  const recentMessages = (messageRows as ChatMessage[]).slice().reverse().slice(0, -1);
  const trendSummary = computeTrendSummary(sessionRows.map((r) => r.data));

  const prompt = buildCoachPrompt({
    phase: phase ?? 1,
    weekNum: weekNum ?? 1,
    dayType: dayType ?? "",
    isDeload: !!isDeload,
    trendSummary,
    recentMessages,
    newMessage: message,
  });

  const claudeRes = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: "claude-sonnet-5",
      max_tokens: 500,
      messages: [{ role: "user", content: prompt }],
    }),
  });

  if (!claudeRes.ok) {
    const errText = await claudeRes.text();
    return jsonResponse({ error: `Claude API error: ${errText}` }, 502);
  }

  const claudeJson = await claudeRes.json();
  const reply = claudeJson.content?.[0]?.text ?? "";

  const { error: insertReplyErr } = await supabase
    .from("chat_messages")
    .insert({ role: "assistant", content: reply });
  if (insertReplyErr) return jsonResponse({ error: insertReplyErr.message }, 500);

  return jsonResponse({ reply });
});
```

- [ ] **Step 5: Type-check**

```bash
deno check supabase/functions/coach/index.ts
```

Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add supabase/functions/coach
git commit -m "Add coach Edge Function with bounded-context prompt and Deno tests"
```

(Deploying this function and confirming the `ANTHROPIC_API_KEY` secret is set are covered in Task 6 — they require an authenticated `supabase` CLI session that this sandboxed environment does not have.)

---

### Task 3: Coach tab — frontend chat UI

**Files:**
- Modify: `index.html` (new tab pane + tab bar button, CSS, `renderCoach()`, shared `sendToCoach()`)

**Interfaces:**
- Consumes: `sb`, `SUPABASE_URL` (existing globals), `getCycleInfo()`, `getStartDate()`, `localDateStr()`, `esc()` (all existing functions in `index.html`).
- Produces: `async function sendToCoach(message)` — Task 4 calls this from the per-exercise button. `function renderCoach()` — called by the existing `renderTab()` dispatcher when the coach tab is active.

- [ ] **Step 1: Register the new tab**

In `index.html`, find `const TABS = ['today','log','schedule','progression','settings'];` and change to:

```js
const TABS = ['today','log','schedule','progression','coach','settings'];
```

- [ ] **Step 2: Add the tab pane and tab bar button**

Find the tab panes section (the `<div id="tab-progression">...</div>` block, immediately followed by `<div id="tab-settings">`). Insert a new pane between them:

```html
<div id="tab-coach" class="tab-pane">
  <div id="coach-inner"></div>
</div>
```

Find the tab bar's `tbtn-progression` button and the `tbtn-settings` button that follows it. Insert a new button between them, using the same `<button class="tab-btn" id="tbtn-X" onclick="goTab('X')">` pattern and SVG icon style as the existing buttons (pick any simple, distinguishable Feather-style icon — e.g. a chat-bubble path — consistent in stroke/size with the existing icons; exact icon choice is not load-bearing):

```html
<button class="tab-btn" id="tbtn-coach" onclick="goTab('coach')">
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor"><path d="M21 11.5a8.38 8.38 0 01-.9 3.8 8.5 8.5 0 01-7.6 4.7 8.38 8.38 0 01-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 01-.9-3.8 8.5 8.5 0 014.7-7.6 8.38 8.38 0 013.8-.9h.5a8.48 8.48 0 018 8v.5z"/></svg>
  Coach
</button>
```

- [ ] **Step 3: Add the CSS**

Find the `.claude-rec`/`.btn-ask-claude` block in the `<style>` section (these are being removed in Task 4, but for this step just add the new Coach-tab styles anywhere in the `<style>` section, e.g. right after that block):

```css
.coach-thread{display:flex;flex-direction:column;gap:10px;padding-bottom:12px}
.coach-msg{max-width:85%;padding:10px 13px;border-radius:14px;font-size:14px;line-height:1.5;white-space:pre-wrap}
.coach-msg.user{align-self:flex-end;background:var(--accent);color:#fff;border-bottom-right-radius:4px}
.coach-msg.assistant{align-self:flex-start;background:var(--card);border:1px solid var(--border);border-bottom-left-radius:4px}
.coach-msg.pending{opacity:.6}
.coach-empty{color:var(--text-secondary);font-size:14px;text-align:center;padding:24px 12px}
.coach-input-row{position:sticky;bottom:0;display:flex;gap:8px;padding:10px 0;background:var(--bg)}
.coach-input{flex:1;min-height:44px;border:1.5px solid var(--border);border-radius:12px;padding:10px 14px;font-size:15px;background:var(--card);color:var(--text);font-family:inherit;resize:none}
.coach-send-btn{min-width:64px;border:none;border-radius:12px;background:var(--accent);color:#fff;font-size:14px;font-weight:600;cursor:pointer}
.coach-send-btn:disabled{opacity:.5;cursor:default}
.coach-error{color:#c0392b;font-size:13px;text-align:center;padding:6px 0}
```

- [ ] **Step 4: Add `renderCoach()` and the shared `sendToCoach()`**

Add these functions near the other tab-render functions (e.g. after `renderSettings()`):

```js
async function renderCoach() {
  const el = document.getElementById('coach-inner');
  el.innerHTML = `
    <div class="ph"><div class="ph-title">Coach</div><div class="ph-sub">Your personal trainer, aware of your whole program</div></div>
    <div class="coach-thread" id="coach-thread"></div>
    <div class="coach-input-row">
      <textarea class="coach-input" id="coach-input" rows="1" placeholder="Ask your coach anything…"></textarea>
      <button class="coach-send-btn" id="coach-send-btn" onclick="handleCoachSend()">Send</button>
    </div>
    <div class="coach-error" id="coach-error"></div>`;

  const { data: rows, error } = await sb
    .from('chat_messages')
    .select('role, content, created_at')
    .order('created_at');

  const threadEl = document.getElementById('coach-thread');
  if (error) {
    document.getElementById('coach-error').textContent = 'Failed to load conversation: ' + error.message;
    return;
  }
  if (!rows.length) {
    threadEl.innerHTML = '<div class="coach-empty">No conversation yet — ask your coach something, or tap "Ask Claude" on any exercise.</div>';
    return;
  }
  threadEl.innerHTML = rows.map(m => `<div class="coach-msg ${m.role}">${esc(m.content)}</div>`).join('');
  threadEl.scrollIntoView({ block: 'end' });
}

function handleCoachSend() {
  const input = document.getElementById('coach-input');
  const message = input.value.trim();
  if (!message) return;
  input.value = '';
  sendToCoach(message);
}

async function sendToCoach(message) {
  const threadEl = document.getElementById('coach-thread');
  const sendBtn = document.getElementById('coach-send-btn');
  const errorEl = document.getElementById('coach-error');
  errorEl.textContent = '';

  if (threadEl.querySelector('.coach-empty')) threadEl.innerHTML = '';
  threadEl.insertAdjacentHTML('beforeend', `<div class="coach-msg user">${esc(message)}</div>`);
  threadEl.insertAdjacentHTML('beforeend', `<div class="coach-msg assistant pending" id="coach-pending">Thinking…</div>`);
  threadEl.scrollIntoView({ block: 'end' });
  if (sendBtn) sendBtn.disabled = true;

  const { data: { session } } = await sb.auth.getSession();
  if (!session) {
    errorEl.textContent = 'Not signed in.';
    document.getElementById('coach-pending')?.remove();
    if (sendBtn) sendBtn.disabled = false;
    return;
  }

  const today = localDateStr();
  const info = getStartDate() ? getCycleInfo(today) : null;
  const phase = info ? info.phase : 1;
  const weekNum = info ? info.weekNum : 1;
  const dayType = info ? info.dayType : '';
  const isDeload = phase === 4 && weekNum <= 22;

  try {
    const res = await fetch(SUPABASE_URL + '/functions/v1/coach', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'Authorization': 'Bearer ' + session.access_token
      },
      body: JSON.stringify({ message, phase, weekNum, dayType, isDeload })
    });
    const body = await res.json();
    if (!res.ok) throw new Error(body.error || 'Request failed');

    const pending = document.getElementById('coach-pending');
    pending.textContent = body.reply;
    pending.classList.remove('pending');
    pending.removeAttribute('id');
  } catch (err) {
    document.getElementById('coach-pending')?.remove();
    errorEl.textContent = 'Error: ' + err.message;
  } finally {
    if (sendBtn) sendBtn.disabled = false;
  }
}
```

- [ ] **Step 5: Wire `renderCoach` into the tab dispatcher**

Find `renderTab(tab)` (near `goTab`) — it dispatches to a per-tab render function keyed by tab name (e.g. an object literal mapping `today`/`log`/`schedule`/`progression`/`settings` to their render functions). Add `coach: renderCoach` to that mapping, following the exact existing pattern for the other tabs.

- [ ] **Step 6: Verify**

Run `node --check` against the extracted `<script>` block content to confirm no syntax errors. Manually re-read `renderTab`'s dispatch object to confirm `coach` maps to `renderCoach` with no typo, and that `TABS`, the tab pane's `id="tab-coach"`, and the button's `id="tbtn-coach"` all use the exact same string `coach` (the `goTab`/`renderTab` functions build these IDs by string concatenation, so a mismatch anywhere silently breaks tab switching for just this one tab).

- [ ] **Step 7: Commit**

```bash
git add index.html
git commit -m "Add Coach tab with persistent chat UI"
```

---

### Task 4: Rewire the per-exercise button, remove the old inline UI, update clearAll

**Files:**
- Modify: `index.html` (the per-exercise button's `onclick`, removal of old `.claude-rec`/`.btn-ask-claude` CSS and the old `askClaude()` function, `clearAll()`)

**Interfaces:**
- Consumes: `sendToCoach()` and `goTab()` (Task 3).

- [ ] **Step 1: Replace the per-exercise button and remove the old inline result container**

Find (in `renderToday()`'s exercise-card template):

```html
          <button class="btn-ask-claude" onclick="askClaude('${ex.name.replace(/'/g, "\\'")}', ${ei})">🤖 Ask Claude</button>
          <div class="claude-rec" id="claude-rec-${ei}"></div>
```

Replace with:

```html
          <button class="btn-ask-claude" onclick="askCoachAboutExercise('${ex.name.replace(/'/g, "\\'")}')">🤖 Ask Claude</button>
```

(The result no longer renders inline here — it goes to the Coach tab.)

- [ ] **Step 2: Replace the old `askClaude` function**

Find and remove the entire old `async function askClaude(exerciseName, ei) { ... }` function (it called `POST .../functions/v1/ask-claude` and rendered into `#claude-rec-${ei}`). Replace it with:

```js
function askCoachAboutExercise(exerciseName) {
  goTab('coach');
  sendToCoach(`Should I adjust weight/reps for ${exerciseName} based on my recent performance?`);
}
```

- [ ] **Step 3: Remove the now-unused CSS**

Remove these rules from the `<style>` section (superseded by Task 3's `.coach-*` rules; `.btn-ask-claude` itself is still used, keep it — only remove the result-rendering rules):

```css
.claude-rec{margin-top:6px;font-size:12px;line-height:1.5}
.claude-rec.loading{color:var(--text-secondary,#888)}
.claude-rec.error{color:#c0392b}
.claude-action{font-weight:600}
.claude-rationale{color:var(--text-secondary,#888)}
```

- [ ] **Step 4: Update `clearAll()` to also delete chat history**

Find:

```js
async function clearAll() {
  if (!confirm('Delete ALL workout data? This cannot be undone.')) return;
  if (!confirm('Final confirmation — permanently clear everything?')) return;
  await sb.from('sessions').delete().not('id', 'is', null);
  await sb.from('user_state').delete().not('user_id', 'is', null);
  cache.sessions = [];
  cache.draft = {};
  cache.startDate = null;
  renderSettings();
  alert('All data cleared.');
}
```

Replace with:

```js
async function clearAll() {
  if (!confirm('Delete ALL workout data? This cannot be undone.')) return;
  if (!confirm('Final confirmation — permanently clear everything?')) return;
  await sb.from('sessions').delete().not('id', 'is', null);
  await sb.from('user_state').delete().not('user_id', 'is', null);
  await sb.from('chat_messages').delete().not('id', 'is', null);
  cache.sessions = [];
  cache.draft = {};
  cache.startDate = null;
  renderSettings();
  alert('All data cleared.');
}
```

- [ ] **Step 5: Verify**

`node --check` on the extracted script block. Grep the file for `ask-claude` and `claude-rec` (the old inline class name) — both should now have zero matches in `index.html` (the old Edge Function's URL path and the old CSS class are both fully retired from the frontend). Grep for `askCoachAboutExercise` and confirm it's both defined once and referenced once (from the button).

- [ ] **Step 6: Commit**

```bash
git add index.html
git commit -m "Rewire per-exercise button to the Coach chat, retire old inline result UI"
```

---

### Task 5: Retire the old `ask-claude` Edge Function

**Files:**
- Delete: `supabase/functions/ask-claude/` (all three files: `logic.ts`, `logic.test.ts`, `index.ts`)

**Interfaces:** none — nothing in `index.html` references this function anymore after Task 4.

- [ ] **Step 1: Confirm nothing still references it**

```bash
grep -rn "ask-claude" index.html supabase/functions/coach/
```

Expected: no output (Task 4 already removed the frontend's reference; the `coach` function is independent code, not a modification of `ask-claude`).

- [ ] **Step 2: Delete the directory**

```bash
git rm -r supabase/functions/ask-claude
git commit -m "Remove ask-claude Edge Function, replaced by coach"
```

(Removing the *deployed* function from the live Supabase project — `supabase functions delete ask-claude` — requires an authenticated CLI session and is covered in Task 6, alongside deploying `coach`.)

---

### Task 6: Deploy and end-to-end verification

**Files:** none (deployment + manual verification only — needs a human with an authenticated `supabase` CLI session and a real browser/phone, same as the original Supabase integration work)

- [ ] **Step 1: Push the new migration to the live project**

```bash
supabase db push
```

Expected: `0003_chat_messages.sql` applies with no errors (the two prior migrations should already show as applied).

- [ ] **Step 2: Deploy `coach`, remove the old deployed `ask-claude`**

```bash
supabase functions deploy coach
supabase functions delete ask-claude
```

- [ ] **Step 3: Manual verification — Coach tab**

Open the live app, sign in, go to the new **Coach** tab. Type a question (e.g. "How's my overall progress?"). Expected: your message appears immediately, a "Thinking…" placeholder appears, then within a few seconds is replaced by Claude's reply. Reload the page and revisit the Coach tab — the exchange should still be there (persisted).

- [ ] **Step 4: Manual verification — per-exercise button**

On the Today tab, tap "🤖 Ask Claude" on any exercise. Expected: the app switches to the Coach tab, and a new question/answer pair about that specific exercise appears at the bottom of the (now-longer) thread — not a separate, disconnected conversation.

- [ ] **Step 5: Manual verification — plan awareness**

If you're not currently in a deload week, this is best-effort/qualitative: ask something like "should I add weight to bench press even though I just started this phase" and read whether the reply's reasoning references phase/RPE-target/deload concepts at all (it should sound aware of the structured program, not purely reactive to raw numbers). This is a soft check — Claude's exact phrasing will vary — the goal is confirming the plan-rules context actually reached the prompt, not grading Claude's coaching style.

- [ ] **Step 6: Confirm cost stays bounded (spot check)**

In the Supabase dashboard's Edge Function logs for `coach`, or by eyeballing 2-3 requests, confirm the request/response sizes don't scale with total chat history — they should look similar in size for an early question vs. a later one in the same testing session, since only the last ~20 messages and ~40 sessions are ever included regardless of how many more exist in the database.
