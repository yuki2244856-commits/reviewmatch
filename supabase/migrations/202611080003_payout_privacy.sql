-- Table-level SELECT overrides column revocations, so replace it with a safe
-- column allowlist. UPDATE privileges and existing row policies are unchanged.
begin;
revoke select on public.creator_profiles from public, anon, authenticated;
revoke select (payout_bank, payout_branch, payout_type, payout_last4, payout_holder)
  on public.creator_profiles from public, anon, authenticated;
do $$
declare public_columns text;
begin
  select string_agg(format('%I', attname), ', ' order by attnum)
    into public_columns
    from pg_catalog.pg_attribute
    where attrelid = 'public.creator_profiles'::regclass
      and attnum > 0 and not attisdropped
      and attname not in (
        'payout_bank', 'payout_branch', 'payout_type', 'payout_last4', 'payout_holder'
      );
  execute format('grant select (%s) on public.creator_profiles to anon, authenticated', public_columns);
end;
$$;

create or replace function public.get_my_payout_account()
returns table (
  payout_bank text, payout_branch text, payout_type text,
  payout_last4 text, payout_holder text
)
language sql stable security definer
set search_path = ''
as $$
  select p.payout_bank::text, p.payout_branch::text, p.payout_type::text,
         p.payout_last4::text, p.payout_holder::text
  from public.creator_profiles as p
  where p.user_id = (select auth.uid());
$$;
revoke all on function public.get_my_payout_account() from public, anon;
grant execute on function public.get_my_payout_account() to authenticated;
commit;
