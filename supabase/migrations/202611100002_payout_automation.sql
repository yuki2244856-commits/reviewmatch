create extension if not exists pg_net;

create table public.stripe_payout_schedule_runs (
  id uuid primary key default gen_random_uuid(),
  account_id text not null,
  phase text not null,
  status text not null,
  detail jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

alter table public.stripe_payout_schedule_runs enable row level security;
create policy stripe_payout_schedule_runs_admin_select
  on public.stripe_payout_schedule_runs for select
  using (public.is_admin());

create or replace function public.run_scheduled_payouts()
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  scheduler_token text;
begin
  select decrypted_secret into scheduler_token
  from vault.decrypted_secrets
  where name = 'payout_scheduler_token'
  limit 1;

  if scheduler_token is null or scheduler_token = '' then
    return;
  end if;

  perform net.http_post(
    url := 'https://kcgxyqfwwhcvjhizootc.supabase.co/functions/v1/stripe-payout-scheduler',
    headers := jsonb_build_object(
      'Authorization', 'Bearer ' || scheduler_token,
      'Content-Type', 'application/json'
    ),
    body := '{}'::jsonb,
    -- Reconciliation and worker checks can take longer than pg_net's default.
    timeout_milliseconds := 120000
  );
end;
$$;

revoke execute on function public.run_scheduled_payouts() from public, anon, authenticated;

do $$
declare
  existing_job record;
begin
  for existing_job in
    select jobid from cron.job where jobname = 'reviewmatch-payout-scheduler'
  loop
    perform cron.unschedule(existing_job.jobid);
  end loop;
  perform cron.schedule(
    'reviewmatch-payout-scheduler',
    '0 0 * * *',
    'select public.run_scheduled_payouts();'
  );
end;
$$;
