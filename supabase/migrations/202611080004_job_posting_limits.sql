begin;
create or replace function public.enforce_job_posting_limit()
returns trigger
language plpgsql security definer
set search_path = ''
as $$
declare
  current_plan text;
  posting_limit integer;
  month_start timestamptz;
begin
  -- All inserts for the same company serialize, including its first posting.
  -- The lock lives until commit/rollback, not just until this trigger returns.
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(new.company_id::text, 0));
  select s.plan into current_plan from public.subscriptions s
    where s.user_id = new.company_id;
  posting_limit := case current_plan when 'プロ' then null when 'スタンダード' then 10 else 1 end;
  month_start := date_trunc('month', statement_timestamp() at time zone 'Asia/Tokyo') at time zone 'Asia/Tokyo';
  -- Creation time is server-owned; a REST client cannot backdate past the quota.
  new.created_at := statement_timestamp();
  if posting_limit is not null and (
    select count(*) from public.jobs j
    where j.company_id = new.company_id
      and j.created_at >= month_start
      and j.created_at < (month_start at time zone 'Asia/Tokyo' + interval '1 month') at time zone 'Asia/Tokyo'
  ) >= posting_limit then
    raise exception '今月の案件掲載上限（%件）に達しています。プランをご確認ください。', posting_limit;
  end if;
  return new;
end;
$$;
revoke all on function public.enforce_job_posting_limit() from public;
create trigger enforce_job_posting_limit before insert on public.jobs
  for each row execute function public.enforce_job_posting_limit();
commit;
