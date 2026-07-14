# Supabase + Claude Recommendations Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move this single-file workout tracker's data off `localStorage` and into Supabase (with single-user magic-link auth), then add an on-demand "Ask Claude" button per exercise that reads that exercise's logged history + freeform notes and returns a weight/reps/exercise-swap recommendation.

**Architecture:** `index.html` stays a single static file (no build step) but gains a Supabase JS client (loaded via CDN `<script>` tag), a login gate, and a small in-memory cache that hydrates from Supabase on login and writes through in the background — so the ~40 existing call sites that read/write workout data via `getSessions()`/`saveSessions()`/`getDraft()`/`saveDraft()`/`getStartDate()` don't need to change. A Supabase Edge Function (`ask-claude`) holds the Anthropic API key server-side, reads the caller's session history under RLS, and calls the Claude API.

**Tech Stack:** Supabase (Postgres + Auth + Edge Functions), `@supabase/supabase-js@2` (UMD build via CDN), Deno (Edge Function runtime + its test runner), Anthropic Messages API (`claude-sonnet-5`).

## Global Constraints

- No build step / bundler for the frontend — all frontend code stays inline in `index.html`, matching the existing file.
- No new frontend test framework — this app has never had one; frontend changes are verified manually in a browser per task, exactly as the existing codebase has always been verified. Only the Edge Function (new, isolated, non-DOM code) gets automated tests, via Deno's built-in test runner.
- Single user — RLS policies are "row belongs to `auth.uid()`", not a multi-tenant model.
- Never commit secrets: `SUPABASE_ANON_KEY` is safe to embed in `index.html` (protected by RLS), but `ANTHROPIC_API_KEY` must only ever live as a Supabase Edge Function secret, never in any committed file.
- App is publicly hosted at `https://cha2sibau-cpu.github.io/workout-tracker/` (GitHub Pages) — this exact URL is the auth redirect target.

---

### Task 1: Local tooling + Supabase project

**Files:** none (environment setup only)

- [ ] **Step 1: Install the Supabase CLI and Docker Desktop via Homebrew**

```bash
brew install supabase/tap/supabase
brew install --cask docker
brew install deno
```

Expected: all three commands finish without error. Then open Docker Desktop once from Applications so its background daemon starts (Supabase's local `functions serve` needs it running).

- [ ] **Step 2: Verify installs**

```bash
supabase --version
docker --version
deno --version
```

Expected: each prints a version string (no "command not found").

- [ ] **Step 3: Create the Supabase project (dashboard)**

Go to https://supabase.com/dashboard, sign in, click "New project". Name it (e.g. `workout-tracker`), choose a region close to you, set a database password (save it somewhere safe — you won't need it for this plan, but Supabase requires setting one). Wait for provisioning to finish (~2 min).

Once created, go to **Project Settings → API** and copy:
- **Project URL** (looks like `https://abcdefghijklm.supabase.co`)
- **Project Reference ID** (the `abcdefghijklm` part)
- **anon public key** (long JWT string)

Keep these three values handy — later steps insert them literally.

- [ ] **Step 4: Link the local repo to the project**

From the repo root:

```bash
cd "/Users/nursatya/Documents/CC Workout Tracker"
supabase login
supabase init
supabase link --project-ref <PROJECT_REF>
```

(Replace `<PROJECT_REF>` with the value from Step 3.) `supabase login` opens a browser to authorize the CLI. `supabase init` creates a `supabase/` directory in the repo.

Expected: `supabase link` prints "Finished supabase link."

- [ ] **Step 5: Commit the generated scaffold**

```bash
git add supabase/config.toml supabase/.gitignore
git commit -m "Add Supabase project scaffold"
```

---

### Task 2: Database schema and RLS

**Files:**
- Create: `supabase/migrations/0001_init.sql`

**Interfaces:**
- Produces: tables `public.sessions(id uuid, user_id uuid, date text, data jsonb, updated_at timestamptz)` unique on `(user_id, date)`, and `public.user_state(user_id uuid primary key, draft jsonb, start_date text)`. Task 4's storage-layer code reads/writes these two tables directly.

- [ ] **Step 1: Write the migration**

```sql
-- supabase/migrations/0001_init.sql

create table public.sessions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) default auth.uid(),
  date text not null,
  data jsonb not null,
  updated_at timestamptz not null default now(),
  unique (user_id, date)
);

alter table public.sessions enable row level security;

create policy "sessions_select_own" on public.sessions
  for select using (auth.uid() = user_id);
create policy "sessions_insert_own" on public.sessions
  for insert with check (auth.uid() = user_id);
create policy "sessions_update_own" on public.sessions
  for update using (auth.uid() = user_id);
create policy "sessions_delete_own" on public.sessions
  for delete using (auth.uid() = user_id);

create table public.user_state (
  user_id uuid primary key references auth.users(id) default auth.uid(),
  draft jsonb not null default '{}'::jsonb,
  start_date text
);

alter table public.user_state enable row level security;

create policy "user_state_select_own" on public.user_state
  for select using (auth.uid() = user_id);
create policy "user_state_insert_own" on public.user_state
  for insert with check (auth.uid() = user_id);
create policy "user_state_update_own" on public.user_state
  for update using (auth.uid() = user_id);
```

- [ ] **Step 2: Push the migration to the hosted project**

```bash
supabase db push
```

Expected: output confirms `0001_init.sql` applied with no errors.

- [ ] **Step 3: Verify schema and RLS in the dashboard**

In the Supabase dashboard, go to **Table Editor** — confirm `sessions` and `user_state` tables exist with the columns above. Go to **Authentication → Policies** — confirm 4 policies on `sessions` and 3 on `user_state`, all referencing `auth.uid() = user_id`.

- [ ] **Step 4: Commit**

```bash
git add supabase/migrations/0001_init.sql
git commit -m "Add sessions/user_state schema with per-user RLS"
```

---

### Task 3: Magic-link auth gate

**Files:**
- Modify: `index.html` (add CDN script tag, login gate markup + CSS, auth JS)

**Interfaces:**
- Produces: global `sb` (the Supabase client), `async function initAuth()`, `async function onAuthed(session)` — Task 4 hooks its `hydrateCache()` call into `onAuthed`, Task 6 reads `sb.auth.getSession()` for the access token.

- [ ] **Step 1: Enable magic-link email auth and the redirect URL (dashboard)**

In the Supabase dashboard: **Authentication → Providers → Email** — confirm it's enabled (it is by default). **Authentication → URL Configuration** — set **Site URL** to `https://cha2sibau-cpu.github.io/workout-tracker/` and add it under **Redirect URLs** too.

- [ ] **Step 2: Add the Supabase client script tag**

In `index.html`, immediately before the existing `<script>` at line 277, add:

```html
<script src="https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/dist/umd/supabase.js"></script>
```

- [ ] **Step 3: Add the login gate markup**

Immediately after `<body>` (index.html:229), before the `<!-- ═══ TAB PANES ═══ -->` comment, add:

```html
<div id="login-gate">
  <div class="login-card">
    <h2>Sign in</h2>
    <p>Enter your email to get a magic link.</p>
    <input type="email" id="login-email" placeholder="you@example.com">
    <button onclick="sendMagicLink()">Send magic link</button>
    <div id="login-status"></div>
  </div>
</div>
```

- [ ] **Step 4: Add login gate CSS**

In the `<style>` block, add (near the other component styles, before `</style>` at index.html:227):

```css
#login-gate{position:fixed;inset:0;background:var(--bg,#f5f5f5);display:flex;align-items:center;justify-content:center;z-index:1000}
.login-card{max-width:320px;width:90%;background:#fff;border-radius:12px;padding:24px;box-shadow:0 2px 12px rgba(0,0,0,.1);text-align:center}
.login-card input{width:100%;padding:10px;margin:12px 0;border:1px solid #ccc;border-radius:8px;font-size:14px;box-sizing:border-box}
.login-card button{width:100%;padding:10px;border:none;border-radius:8px;background:var(--accent,#2563eb);color:#fff;font-size:14px;cursor:pointer}
#login-status{margin-top:10px;font-size:12px;color:var(--text-secondary,#888)}
body.authed #login-gate{display:none}
body:not(.authed) .tab-bar,body:not(.authed) .tab-pane{display:none}
```

- [ ] **Step 5: Add the auth JS and Supabase client**

In the main `<script>` block, right after the `CONSTANTS & DATA` section's `WORKOUTS` close (after index.html:354, before the `LOG VIEW STATE` comment), add:

```js
// ════════════════════════════════════════════════════
//  SUPABASE CLIENT & AUTH
// ════════════════════════════════════════════════════

const SUPABASE_URL = '<PROJECT_URL_FROM_TASK_1>';
const SUPABASE_ANON_KEY = '<ANON_KEY_FROM_TASK_1>';
const sb = supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

async function sendMagicLink() {
  const email = document.getElementById('login-email').value.trim();
  const statusEl = document.getElementById('login-status');
  if (!email) { statusEl.textContent = 'Enter an email.'; return; }
  statusEl.textContent = 'Sending...';
  const { error } = await sb.auth.signInWithOtp({
    email,
    options: { emailRedirectTo: window.location.href }
  });
  statusEl.textContent = error ? `Error: ${error.message}` : 'Check your email for the magic link.';
}

async function signOut() {
  await sb.auth.signOut();
  document.body.classList.remove('authed');
  location.reload();
}

async function initAuth() {
  const { data: { session } } = await sb.auth.getSession();
  if (session) { await onAuthed(session); return; }
  sb.auth.onAuthStateChange(async (_event, newSession) => {
    if (newSession && !document.body.classList.contains('authed')) await onAuthed(newSession);
  });
}

async function onAuthed(session) {
  document.body.classList.add('authed');
  await hydrateCache();
  await migrateLocalStorageIfNeeded();
  renderTab('today');
}
```

(Replace `<PROJECT_URL_FROM_TASK_1>` and `<ANON_KEY_FROM_TASK_1>` with the real values from Task 1 Step 3. `hydrateCache` and `migrateLocalStorageIfNeeded` are defined in Task 4 — this step will not run correctly until that task is also done, which is fine since Task 4 is next.)

- [ ] **Step 6: Replace the entry point**

At the end of the file (index.html:1500), replace:

```js
renderTab('today');
```

with:

```js
initAuth();
```

- [ ] **Step 7: Manual verification** (after Task 4 is also complete, since `hydrateCache` doesn't exist yet)

Open `index.html` in a browser. Expected: the login gate covers the screen, tabs are hidden. Enter your real email, click "Send magic link", confirm the status text changes to "Check your email...". Open the email, click the link — it should land back on the app with the login gate gone and the Today tab visible. Refresh the page — you should stay logged in (no gate reappearing).

- [ ] **Step 8: Commit**

```bash
git add index.html
git commit -m "Add Supabase magic-link auth gate"
```

---

### Task 4: Storage layer — Supabase-backed cache

**Files:**
- Modify: `index.html:525-541` (storage helpers), `index.html:1481-1484` (`saveStartDate`), `index.html:1486-1494` (`clearAll`), `index.html:1478` (footer copy)

**Interfaces:**
- Consumes: `sb` (Task 3).
- Produces: `async function hydrateCache()`, `async function migrateLocalStorageIfNeeded()` — both called from Task 3's `onAuthed`. Keeps `getSessions()`, `saveSessions(v)`, `getDraft()`, `saveDraft(v)`, `getStartDate()`, `saveStartDate(val)` with their existing names/signatures so none of the ~40 existing call sites change.

- [ ] **Step 1: Replace the storage helpers**

Replace index.html:525-541 (everything from the `STORAGE HELPERS` section header comment through the `getStartDate()` function) with:

```js
// ════════════════════════════════════════════════════
//  STORAGE HELPERS (Supabase-backed, with local cache)
// ════════════════════════════════════════════════════

// Legacy localStorage accessor — kept only so migrateLocalStorageIfNeeded()
// can read pre-Supabase data once.
function ls(key, val) {
  const k = PFX + key;
  if (val === undefined) {
    try { return JSON.parse(localStorage.getItem(k)); } catch { return null; }
  }
  localStorage.setItem(k, JSON.stringify(val));
}

const cache = { sessions: [], draft: {}, startDate: null };

async function hydrateCache() {
  const { data: sessionRows, error: sessErr } = await sb.from('sessions').select('data').order('date');
  if (sessErr) { alert('Failed to load sessions: ' + sessErr.message); return; }
  cache.sessions = sessionRows.map(r => r.data);

  const { data: stateRow, error: stateErr } = await sb.from('user_state').select('draft,start_date').maybeSingle();
  if (stateErr) { alert('Failed to load app state: ' + stateErr.message); return; }
  cache.draft = stateRow?.draft || {};
  cache.startDate = stateRow?.start_date || null;
}

async function migrateLocalStorageIfNeeded() {
  if (cache.sessions.length > 0) return; // Supabase already has data
  const localSessions = ls('sessions') || [];
  const localDraft = ls('draft') || {};
  const localStart = ls('startDate') || null;
  if (!localSessions.length && !localStart) return; // nothing local to migrate

  if (localSessions.length) await saveSessions(localSessions);
  if (Object.keys(localDraft).length) await saveDraft(localDraft);
  if (localStart) await saveStartDate(localStart);
}

function getSessions() { return cache.sessions; }
async function saveSessions(v) {
  cache.sessions = v;
  if (!v.length) return;
  const rows = v.map(s => ({ date: s.date, data: s }));
  const { error } = await sb.from('sessions').upsert(rows, { onConflict: 'user_id,date' });
  if (error) console.error('saveSessions failed', error);
}

function getDraft() { return cache.draft; }
async function saveDraft(v) {
  cache.draft = v;
  const { error } = await sb.from('user_state').upsert({ draft: v }, { onConflict: 'user_id' });
  if (error) console.error('saveDraft failed', error);
}

function getStartDate() { return cache.startDate; }
```

- [ ] **Step 2: Update `saveStartDate`**

Replace index.html:1481-1484:

```js
function saveStartDate(val) {
  ls('startDate', val);
  renderSettings();
}
```

with:

```js
async function saveStartDate(val) {
  cache.startDate = val;
  renderSettings();
  const { error } = await sb.from('user_state').upsert({ start_date: val }, { onConflict: 'user_id' });
  if (error) console.error('saveStartDate failed', error);
}
```

- [ ] **Step 3: Update `clearAll` to clear Supabase, not localStorage**

Replace index.html:1486-1494:

```js
function clearAll() {
  if (!confirm('Delete ALL workout data? This cannot be undone.')) return;
  if (!confirm('Final confirmation — permanently clear everything?')) return;
  Object.keys(localStorage)
    .filter(k => k.startsWith(PFX))
    .forEach(k => localStorage.removeItem(k));
  renderSettings();
  alert('All data cleared.');
}
```

with:

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

- [ ] **Step 4: Update the settings footer copy and add a sign-out button**

At index.html:1478, replace:

```html
<div style="text-align:center;font-size:12px;color:var(--text-secondary)">All data stored on this device · No account needed</div>`;
```

with:

```html
<button class="btn" onclick="signOut()">Sign out</button>
<div style="height:10px"></div>
<div style="text-align:center;font-size:12px;color:var(--text-secondary)">Synced to your account via Supabase</div>`;
```

- [ ] **Step 5: Manual verification**

Open the app (already logged in from Task 3). Log a set with a note on today's workout, click "Mark Complete". Open the Supabase dashboard **Table Editor → sessions** — confirm a row exists with today's date and your logged data in the `data` column. Reload the page — confirm the logged session still shows (proves `hydrateCache` works, not just the write). In **Settings**, click "Sign out", confirm the login gate reappears; sign back in via magic link, confirm your data is still there.

If you had prior workout history in this browser's `localStorage` from before this change: after first sign-in, check **Table Editor → sessions** — confirm your old history rows appear (proves `migrateLocalStorageIfNeeded` ran).

- [ ] **Step 6: Commit**

```bash
git add index.html
git commit -m "Move session/draft/settings storage from localStorage to Supabase"
```

---

### Task 5: `ask-claude` Edge Function

**Files:**
- Create: `supabase/functions/ask-claude/logic.ts`
- Create: `supabase/functions/ask-claude/logic.test.ts`
- Create: `supabase/functions/ask-claude/index.ts`

**Interfaces:**
- Produces: deployed function at `POST {SUPABASE_URL}/functions/v1/ask-claude`, request body `{ exerciseName: string }`, response body `{ action: "increase_weight"|"hold"|"decrease_weight"|"increase_reps"|"swap_exercise", detail: string, rationale: string }` on 200, or `{ error: string }` on 4xx/5xx. Task 6's frontend button calls this exact shape.

- [ ] **Step 1: Write the pure logic module**

```ts
// supabase/functions/ask-claude/logic.ts

export interface SetEntry { kg?: string; reps?: string; rpe?: string; note?: string; }
export interface ExerciseEntry { name: string; sets: SetEntry[]; }
export interface SessionData { date: string; dayType?: string; exercises: ExerciseEntry[]; }
export interface HistoryPoint { date: string; sets: SetEntry[]; }
export interface Recommendation {
  action: "increase_weight" | "hold" | "decrease_weight" | "increase_reps" | "swap_exercise";
  detail: string;
  rationale: string;
}

const VALID_ACTIONS = ["increase_weight", "hold", "decrease_weight", "increase_reps", "swap_exercise"];

export function extractExerciseHistory(sessions: SessionData[], exerciseName: string): HistoryPoint[] {
  return sessions
    .map((s) => {
      const ex = s.exercises?.find((e) => e.name === exerciseName);
      return ex ? { date: s.date, sets: ex.sets } : null;
    })
    .filter((h): h is HistoryPoint => h !== null);
}

export function buildPrompt(exerciseName: string, history: HistoryPoint[]): string {
  const lines = history.map((h) => {
    const setsDesc = h.sets
      .map((s) => `${s.kg || "?"}kg x ${s.reps || "?"} reps @ RPE ${s.rpe || "?"}${s.note ? ` (note: "${s.note}")` : ""}`)
      .join("; ");
    return `${h.date}: ${setsDesc}`;
  });

  return [
    `You are a strength coach reviewing progress on "${exerciseName}".`,
    `Recent session history (most recent first):`,
    lines.length ? lines.join("\n") : "No prior history logged for this exercise.",
    ``,
    `Based on this history, including any freeform notes the lifter left, decide whether to increase weight, hold, decrease weight, increase reps, or swap the exercise for something else. Pay special attention to notes about pain, fatigue, or asymmetry (e.g. one side being weaker) — these should override a pure numbers-based progression.`,
    `Reply with ONLY a JSON object, no other text, matching exactly:`,
    `{"action": "increase_weight" | "hold" | "decrease_weight" | "increase_reps" | "swap_exercise", "detail": "<short specific instruction>", "rationale": "<one or two sentence reason>"}`,
  ].join("\n");
}

export function parseClaudeReply(text: string): Recommendation {
  const trimmed = text.trim().replace(/^```json\s*/i, "").replace(/```$/, "").trim();
  const parsed = JSON.parse(trimmed);
  if (!VALID_ACTIONS.includes(parsed.action) || typeof parsed.detail !== "string" || typeof parsed.rationale !== "string") {
    throw new Error(`Unexpected Claude response shape: ${text}`);
  }
  return parsed as Recommendation;
}
```

- [ ] **Step 2: Write the failing tests**

```ts
// supabase/functions/ask-claude/logic.test.ts

import { assertEquals, assertThrows } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { buildPrompt, extractExerciseHistory, parseClaudeReply } from "./logic.ts";

Deno.test("extractExerciseHistory pulls only the matching exercise across sessions", () => {
  const sessions = [
    { date: "2026-07-10", exercises: [{ name: "Lat Pulldown", sets: [{ kg: "20", reps: "12", rpe: "7" }] }] },
    { date: "2026-07-08", exercises: [{ name: "DB bench press", sets: [{ kg: "24", reps: "10", rpe: "8" }] }] },
  ];
  const history = extractExerciseHistory(sessions, "Lat Pulldown");
  assertEquals(history.length, 1);
  assertEquals(history[0].date, "2026-07-10");
});

Deno.test("buildPrompt includes notes so Claude can react to them", () => {
  const prompt = buildPrompt("Overhead DB press", [
    { date: "2026-07-10", sets: [{ kg: "18", reps: "8", rpe: "7", note: "left arm weaker" }] },
  ]);
  assertEquals(prompt.includes("left arm weaker"), true);
  assertEquals(prompt.includes("Overhead DB press"), true);
});

Deno.test("parseClaudeReply parses a valid JSON response", () => {
  const rec = parseClaudeReply('{"action":"hold","detail":"Stay at 18kg","rationale":"RPE already at cap."}');
  assertEquals(rec.action, "hold");
});

Deno.test("parseClaudeReply strips a markdown code fence if present", () => {
  const rec = parseClaudeReply('```json\n{"action":"increase_weight","detail":"Go to 22kg","rationale":"Hit top of range."}\n```');
  assertEquals(rec.action, "increase_weight");
});

Deno.test("parseClaudeReply throws on an invalid action", () => {
  assertThrows(() => parseClaudeReply('{"action":"nonsense","detail":"x","rationale":"y"}'));
});
```

- [ ] **Step 3: Run the tests to verify they fail**

```bash
deno test supabase/functions/ask-claude/logic.test.ts
```

Expected: FAIL — `logic.ts` doesn't exist yet is not the case (we wrote it in Step 1), so this should actually mostly PASS already since Steps 1 and 2 were written together. Run it anyway to confirm the file compiles and every test passes before moving on — if any fails, fix `logic.ts` until all 5 pass.

- [ ] **Step 4: Run the tests to verify they pass**

```bash
deno test supabase/functions/ask-claude/logic.test.ts
```

Expected: `ok | 5 passed | 0 failed`.

- [ ] **Step 5: Write the HTTP handler**

```ts
// supabase/functions/ask-claude/index.ts

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { buildPrompt, extractExerciseHistory, parseClaudeReply } from "./logic.ts";

const ANTHROPIC_API_KEY = Deno.env.get("ANTHROPIC_API_KEY")!;
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;

Deno.serve(async (req) => {
  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "Method not allowed" }), { status: 405 });
  }

  const authHeader = req.headers.get("Authorization");
  if (!authHeader) {
    return new Response(JSON.stringify({ error: "Missing Authorization header" }), { status: 401 });
  }

  const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    global: { headers: { Authorization: authHeader } },
  });

  const { data: userData, error: userErr } = await supabase.auth.getUser();
  if (userErr || !userData.user) {
    return new Response(JSON.stringify({ error: "Invalid session" }), { status: 401 });
  }

  let exerciseName: string;
  try {
    const body = await req.json();
    exerciseName = body.exerciseName;
  } catch {
    return new Response(JSON.stringify({ error: "Invalid JSON body" }), { status: 400 });
  }
  if (!exerciseName || typeof exerciseName !== "string") {
    return new Response(JSON.stringify({ error: "exerciseName is required" }), { status: 400 });
  }

  const { data: rows, error: dbErr } = await supabase
    .from("sessions")
    .select("data")
    .order("date", { ascending: false })
    .limit(10);
  if (dbErr) {
    return new Response(JSON.stringify({ error: dbErr.message }), { status: 500 });
  }

  const history = extractExerciseHistory(rows.map((r) => r.data), exerciseName);
  const prompt = buildPrompt(exerciseName, history);

  const claudeRes = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: "claude-sonnet-5",
      max_tokens: 400,
      messages: [{ role: "user", content: prompt }],
    }),
  });

  if (!claudeRes.ok) {
    const errText = await claudeRes.text();
    return new Response(JSON.stringify({ error: `Claude API error: ${errText}` }), { status: 502 });
  }

  const claudeJson = await claudeRes.json();
  const text = claudeJson.content?.[0]?.text ?? "";

  let recommendation;
  try {
    recommendation = parseClaudeReply(text);
  } catch (e) {
    return new Response(JSON.stringify({ error: String(e) }), { status: 502 });
  }

  return new Response(JSON.stringify(recommendation), {
    headers: { "content-type": "application/json" },
  });
});
```

- [ ] **Step 6: Set the Anthropic API key as a secret**

```bash
supabase secrets set ANTHROPIC_API_KEY=<your-key>
```

Expected: confirmation that the secret was set. (`SUPABASE_URL` and `SUPABASE_ANON_KEY` are automatically injected into every Edge Function by Supabase — no need to set those manually.)

- [ ] **Step 7: Deploy the function**

```bash
supabase functions deploy ask-claude
```

Expected: output confirms the function deployed and prints its URL (`{SUPABASE_URL}/functions/v1/ask-claude`).

- [ ] **Step 8: Manual smoke test with curl**

Get a fresh access token by opening the app in a browser (logged in), then in the browser devtools console run `(await sb.auth.getSession()).data.session.access_token` and copy the printed value. Then:

```bash
curl -i -X POST "<SUPABASE_URL>/functions/v1/ask-claude" \
  -H "Authorization: Bearer <paste-token>" \
  -H "Content-Type: application/json" \
  -d '{"exerciseName":"Lat Pulldown"}'
```

Expected: `200 OK` with a JSON body containing `action`, `detail`, `rationale`. If you have no logged history yet for that exercise, Claude should still return a reasonable "no prior data" recommendation rather than erroring.

- [ ] **Step 9: Commit**

```bash
git add supabase/functions/ask-claude
git commit -m "Add ask-claude Edge Function with Deno unit tests"
```

---

### Task 6: Frontend "Ask Claude" button

**Files:**
- Modify: `index.html:750` (exercise card rendering, inside `renderToday`)

**Interfaces:**
- Consumes: `sb`, `SUPABASE_URL` (Task 3); deployed `ask-claude` function (Task 5).

- [ ] **Step 1: Add the button and result container to each exercise card**

At index.html:750, replace:

```js
          ${recHtml}${noteHtml}
```

with:

```js
          ${recHtml}${noteHtml}
          <button class="btn-ask-claude" onclick="askClaude('${ex.name.replace(/'/g, "\\'")}', ${ei})">🤖 Ask Claude</button>
          <div class="claude-rec" id="claude-rec-${ei}"></div>
```

- [ ] **Step 2: Add the CSS**

In the `<style>` block, add:

```css
.btn-ask-claude{margin-top:6px;padding:5px 10px;font-size:12px;border:1px solid var(--accent,#2563eb);color:var(--accent,#2563eb);background:none;border-radius:6px;cursor:pointer}
.claude-rec{margin-top:6px;font-size:12px;line-height:1.5}
.claude-rec.loading{color:var(--text-secondary,#888)}
.claude-rec.error{color:#c0392b}
.claude-action{font-weight:600}
.claude-rationale{color:var(--text-secondary,#888)}
```

- [ ] **Step 3: Add the `askClaude` function**

Add near the other Today-tab functions (after `renderToday`'s closing, or anywhere in the main script before it's called):

```js
async function askClaude(exerciseName, ei) {
  const el = document.getElementById('claude-rec-' + ei);
  el.className = 'claude-rec loading';
  el.textContent = 'Asking Claude…';

  const { data: { session } } = await sb.auth.getSession();
  if (!session) { el.className = 'claude-rec error'; el.textContent = 'Not signed in.'; return; }

  try {
    const res = await fetch(SUPABASE_URL + '/functions/v1/ask-claude', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'Authorization': 'Bearer ' + session.access_token
      },
      body: JSON.stringify({ exerciseName })
    });
    const body = await res.json();
    if (!res.ok) throw new Error(body.error || 'Request failed');

    const actionLabel = {
      increase_weight: '↑ Increase weight',
      hold: '→ Hold',
      decrease_weight: '↓ Decrease weight',
      increase_reps: '↑ Increase reps',
      swap_exercise: '⇄ Swap exercise'
    }[body.action] || body.action;

    el.className = 'claude-rec';
    el.innerHTML = `<div class="claude-action">${actionLabel}: ${esc(body.detail)}</div><div class="claude-rationale">${esc(body.rationale)}</div>`;
  } catch (err) {
    el.className = 'claude-rec error';
    el.textContent = 'Error: ' + err.message;
  }
}
```

- [ ] **Step 4: Manual verification**

Open the app, go to a day with logged history and at least one set that has a note (e.g. "left arm weaker" on Overhead DB press). Click "🤖 Ask Claude" on that exercise. Expected: button shows "Asking Claude…", then within a few seconds shows an action + short instruction + rationale, and the rationale should visibly reference the note's content when it's relevant (e.g. mentions the asymmetry) rather than being purely numbers-based. Try it also on an exercise with zero history — expect a sensible "start light" style response instead of an error.

- [ ] **Step 5: Commit**

```bash
git add index.html
git commit -m "Add Ask Claude button to exercise cards"
```

---

### Task 7: End-to-end verification

**Files:** none (verification only)

- [ ] **Step 1: Fresh-login flow** — Sign out via Settings, reload, confirm the login gate appears, sign in again via magic link, confirm all previously logged history is present (Log tab) and the Today tab renders the current day's plan correctly, including the new "Ask Claude" buttons.

- [ ] **Step 2: Cross-device check** — Open the app on a second device/browser (or an incognito window) signed in with the same email. Confirm the same session history appears — this is the payoff of moving off `localStorage`.

- [ ] **Step 3: RLS sanity check** — In a private/incognito window, open the app's Supabase REST endpoint directly without a valid user session (e.g. `curl "<SUPABASE_URL>/rest/v1/sessions" -H "apikey: <ANON_KEY>"` with no `Authorization` bearer token beyond the anon key). Expected: an empty result or a permission error — not your workout data — proving RLS is enforced for unauthenticated requests.

- [ ] **Step 4: Push to GitHub Pages**

```bash
git push
```

Expected: GitHub Pages rebuilds automatically (it serves directly from `main`); reload `https://cha2sibau-cpu.github.io/workout-tracker/` after a minute and confirm the deployed site shows the login gate and, once signed in, functions identically to local testing.
