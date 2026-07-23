-- supabase/migrations/0004_user_state_pauses.sql
--
-- Adds a `pauses` column to user_state so the app can freeze program
-- progression during breaks (e.g. travel). It stores an array of
-- { "start": "YYYY-MM-DD", "end": "YYYY-MM-DD" } local-date intervals
-- (both ends inclusive, non-overlapping). Existing RLS policies and grants
-- on user_state already cover this column — no new policies required.

alter table public.user_state
  add column if not exists pauses jsonb not null default '[]'::jsonb;
