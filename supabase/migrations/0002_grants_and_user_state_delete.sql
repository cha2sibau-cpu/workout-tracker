-- 0001_init.sql enabled RLS and added policies for sessions/user_state, but
-- RLS policies only restrict access within privileges a role already has —
-- they don't grant privileges on their own. Without these grants, every
-- Supabase call from an authenticated user fails with "permission denied".
grant select, insert, update, delete on public.sessions to authenticated;
grant select, insert, update, delete on public.user_state to authenticated;

-- 0001_init.sql was also missing a delete policy on user_state, so
-- clearAll()'s delete on that table silently deleted 0 rows.
create policy "user_state_delete_own" on public.user_state
  for delete using (auth.uid() = user_id);
