begin;
alter table public.jobs add column if not exists priority boolean not null default false;

create or replace function public.enforce_job_priority()
returns trigger
language plpgsql security definer
set search_path = ''
as $$
begin
  if tg_op = 'UPDATE' then
    if new.priority is distinct from old.priority then
      raise exception '優先掲載は案件作成時に選択してください。';
    end if;
  elsif new.priority and not exists (
    select 1 from public.subscriptions s
    where s.user_id = new.company_id and s.plan in ('スタンダード', 'プロ')
  ) then
    raise exception '優先掲載はスタンダード・プロで利用できます。';
  end if;
  return new;
end;
$$;
revoke all on function public.enforce_job_priority() from public;
create trigger enforce_job_priority before insert or update on public.jobs
  for each row execute function public.enforce_job_priority();
commit;
