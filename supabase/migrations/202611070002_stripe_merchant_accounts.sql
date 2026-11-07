-- Retain legacy columns for audited migrations; new direct-charge readiness uses v2 merchant capability.
alter table public.stripe_accounts add column api_generation text not null default 'v1' check (api_generation in ('v1', 'v2'));
alter table public.stripe_accounts add column card_payments_status text not null default 'inactive';
create table public.stripe_risk_events (
  event_id text primary key, event_type text not null, object_id text not null,
  stripe_account_id text not null, received_at timestamptz not null default now(),
  reviewed_at timestamptz
);
alter table public.stripe_risk_events enable row level security;
revoke all on public.stripe_risk_events from anon, authenticated;
grant all on public.stripe_risk_events to service_role;

create function public.apply_stripe_merchant_event(p_event_id text, p_created bigint, p_account_id text, p_card_status text)
returns void language plpgsql security definer set search_path = '' as $$
begin
  insert into public.stripe_events(event_id, created) values (p_event_id, p_created) on conflict do nothing;
  if not found then return; end if;
  if not exists (select 1 from public.stripe_accounts where account_id = p_account_id and api_generation = 'v2') then
    raise exception 'Unmapped merchant account';
  end if;
  update public.stripe_accounts set card_payments_status = p_card_status, event_created = p_created
    where account_id = p_account_id and api_generation = 'v2' and event_created <= p_created;
end;
$$;
revoke all on function public.apply_stripe_merchant_event(text, bigint, text, text) from public, anon, authenticated;
grant execute on function public.apply_stripe_merchant_event(text, bigint, text, text) to service_role;
