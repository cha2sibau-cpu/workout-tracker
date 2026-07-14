# Coach Chat — Design Spec

## Context

The Supabase + Claude integration shipped earlier (see `docs/superpowers/plans/2026-07-14-supabase-claude-integration.md`) added a narrow "Ask Claude" button per exercise: it only sees that one exercise's last 10 sessions, with no awareness of the periodization plan (phase, deload weeks, RPE ceilings). The user wants Claude to act as a real personal trainer — one that understands the whole program, not just isolated exercise history — while explicitly worrying about two real engineering risks: (1) token cost/context growing unbounded as months of logs and conversation accumulate, and (2) a long-term, safety-first coaching philosophy (no aggressive short-term progression that risks injury), since this program is meant to run for years.

This spec covers the redesign: a persistent, holistic "Coach" chat that replaces the narrow per-exercise assistant, while keeping cost and context bounded regardless of how long the user has been logging.

## Decisions made (from brainstorming)

- **One continuous, ever-growing conversation thread**, persisted in Supabase — not per-session, not cleared on login, no separate "conversations" list.
- **Bounded cost, not bounded history**: the *stored* thread can grow forever cheaply (it's just DB rows); what's *sent to Claude* per question is always a fixed-size window (recent messages + a compact trend summary), never the full thread. Cost per question stays roughly flat over the life of the app.
- **No rolling memory summarization in v1** (YAGNI) — if the user asks about something outside the recent window, Claude won't have it. Acceptable tradeoff for now; a candidate v2 enhancement if it turns out to matter in practice.
- **Both entry points feed the same thread**: the existing per-exercise button and a new dedicated Coach tab. The button becomes a shortcut that sends a pre-filled question ("Should I adjust weight/reps for X based on my recent performance?") through the exact same pipeline as a typed question, then switches to the Coach tab to show the exchange — it no longer renders a separate inline reply on the exercise card.
- **Explicit safety-first system instruction**: told to Claude on every request — prioritize long-term, sustainable progress; be conservative about recommending weight/rep increases; flag anything resembling too-rapid load growth. This is a multi-year program, not a race.

## Data model

New table, `chat_messages`, alongside the existing `sessions`/`user_state` (same RLS pattern):

```sql
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

No update policy — individual messages are never edited in place, only inserted or (via "Clear All Data") deleted wholesale. A delete policy/grant is included specifically because `clearAll()` (Settings' "Clear All Data") is extended to also delete the user's `chat_messages` rows, consistent with it wiping all of the user's data — without it, that delete would silently affect 0 rows under RLS, the exact bug already found and fixed once in this project's `user_state` table. **GRANTs are included in the same migration as the table this time** — the original Supabase migration shipped without them and had to be patched after the fact; this spec exists partly so that doesn't repeat.

## Context assembly (the part that keeps cost bounded)

Every request to the new Edge Function assembles, server-side:

1. **Static plan rules** — a compact, hardcoded summary of the periodization plan (phase 1-4 structure, RPE targets/ceilings, deload timing) living directly in the Edge Function's source. This intentionally duplicates the phase-card prose already hardcoded client-side in `renderSchedule()` and the per-exercise `warning` fields in `WORKOUTS` — both are static app configuration that essentially never changes, so a second hardcoded copy is an acceptable simplification rather than building a shared-config sync mechanism. Flagged here explicitly as a known duplication, not an oversight.
2. **Current phase/week/deload state** — computed client-side (the app already has `getCycleInfo(dateStr)` for this) and sent in the request body, rather than re-implemented in the Edge Function. `isDeload` is derived as `phase === 4 && weekNum <= 22` (weeks 21-22 of phase 4 are the deload block per the existing Schedule tab text; weeks 23-26 are "reassess").
3. **A compact per-exercise trend summary** — computed server-side from the `sessions` table (most recent ~40 sessions, bounded), one line per exercise that has history (e.g. first-logged vs. most-recent weight, direction, latest RPE) — not raw per-set data for every session ever logged. This is the piece that lets Claude reason about "the whole program" without the payload growing linearly with months of use.
4. **The last ~15-20 messages** of the persisted `chat_messages` thread (bounded window, not the full history).
5. **The safety-first system instruction** described above.
6. **The new user message** (typed in the Coach tab, or the pre-filled question from a per-exercise button).

Sizing note: items 1, 3, 4, 5 are all bounded/roughly-constant regardless of how long the app has been used; only item 4's window and item 3's exercise count grow with the *number of distinct exercises in the program* (fixed, ~20) — not with elapsed time. This is what keeps per-question cost flat over years of use, addressing the user's stated concern directly.

## Edge Function

New function, `supabase/functions/coach/` (parallel structure to the existing `ask-claude/`: `logic.ts` for pure functions, `logic.test.ts` for Deno tests, `index.ts` for the HTTP handler). This **replaces** `ask-claude` — the old function and its inline per-exercise rendering are retired as part of this change, not kept alongside it.

- **Auth**: identical pattern to `ask-claude` — forward the caller's JWT into a Supabase client (`global.headers.Authorization`), never use the service role. `supabase.auth.getUser()` validates before any DB work.
- **Request**: `POST { message: string, phase: number, weekNum: number, dayType: string, isDeload: boolean }`.
- **Behavior**: insert the user message into `chat_messages` → fetch bounded session history + bounded recent chat messages (both RLS-scoped to the caller) → build the prompt per the context-assembly section above → call the Anthropic Messages API (`claude-sonnet-5`) → insert the assistant's reply into `chat_messages` → return it.
- **Response**: `{ reply: string }` on success — a plain freeform string, not the old structured `{action, detail, rationale}` JSON. The interaction model has shifted from "give me one categorized recommendation" to "have a conversation," so forcing replies into a rigid schema no longer fits; this also removes the fragile markdown-fence-stripping/JSON-parsing step the old function needed. Errors: `{ error: string }` at appropriate 4xx/5xx codes, same CORS-header-on-every-response pattern (`jsonResponse` helper) established in `ask-claude`.
- **Testing**: Deno tests for the pure parts — the trend-summary computation (given a list of sessions, produces the right one-line-per-exercise summary) and the prompt-building function (given trend summary + phase state + recent messages + new message, produces a prompt that includes all of them, and specifically includes the safety-first instruction and the deload flag when `isDeload` is true).

## Frontend

- **New "Coach" tab**: sixth entry in `TABS`/`goTab`/the tab bar (following the exact existing pattern — `tab-coach` pane, `tbtn-coach` button, an SVG icon consistent with the others). Renders the full persisted thread (fetched via `sb.from('chat_messages').select(...).order('created_at')`) as a simple message list (user messages right-aligned or styled distinctly from assistant replies, matching the app's existing minimal aesthetic — no new design system, reuse existing card/badge CSS conventions), plus a text input + send button at the bottom. Auto-scrolls to the newest message. Loading state while awaiting a reply; error state (visible, not just `console.error`) if the request fails — consistent with the alert-on-failure convention already established for storage errors.
- **Per-exercise button**: keeps its existing placement/styling on the exercise card, but its `onclick` now builds the pre-filled question, calls the same send-to-coach flow used by the Coach tab's input, and switches to the Coach tab (`goTab('coach')`) to show the result. The old inline `<div class="claude-rec">` result rendering on the exercise card is removed.
- Both paths share one JS function for "send a message to the coach" (build request body with current `getCycleInfo()` state, POST to the Edge Function, append both the user message and the reply to the rendered thread, persist via the Edge Function's own inserts — the client doesn't need to separately write to `chat_messages`, only read it).

## Out of scope for this pass (explicitly, to avoid scope creep)

- Rolling/periodic summarization of older conversation into a standing memory (candidate v2).
- Editing or deleting individual chat messages, or starting a fresh/separate thread.
- Including chat history in the Settings "Export Backup" JSON (that button's scope stays the workout data it already covers).
