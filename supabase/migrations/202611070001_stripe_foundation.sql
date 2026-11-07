-- Separate Stripe-owned state. Never trust browser-written demo subscriptions/payments for entitlements.
create table public.stripe_customers (
  user_id uuid primary key references auth.users(id), customer_id text not null unique
);
create table public.stripe_accounts (
  user_id uuid primary key references auth.users(id), account_id text not null unique,
  charges_enabled boolean not null default false, payouts_enabled boolean not null default false,
  transfers_enabled boolean not null default false, details_submitted boolean not null default false,
  event_created bigint not null default 0
);
create table public.stripe_subscriptions (
  subscription_id text primary key, user_id uuid not null references auth.users(id), customer_id text not null,
  status text not null, plan text, entitled boolean not null default false, event_created bigint not null
);
create table public.stripe_events (event_id text primary key, created bigint not null, received_at timestamptz not null default now());
alter table public.stripe_customers enable row level security;
alter table public.stripe_accounts enable row level security;
alter table public.stripe_subscriptions enable row level security;
alter table public.stripe_events enable row level security;
revoke all on public.stripe_customers, public.stripe_accounts, public.stripe_subscriptions, public.stripe_events from anon, authenticated;
grant select on public.stripe_accounts, public.stripe_subscriptions to authenticated;
grant all on public.stripe_customers, public.stripe_accounts, public.stripe_subscriptions, public.stripe_events to service_role;
create policy own_stripe_account on public.stripe_accounts for select to authenticated using (user_id = (select auth.uid()));
create policy own_stripe_subscription on public.stripe_subscriptions for select to authenticated using (user_id = (select auth.uid()));

create function public.apply_stripe_event(p_event_id text, p_created bigint, p_kind text, p_state jsonb)
returns void language plpgsql security definer set search_path = '' as $$
begin
  insert into public.stripe_events(event_id, created) values (p_event_id, p_created) on conflict do nothing;
  if not found then return; end if;
  if p_kind = 'subscription' then
    insert into public.stripe_subscriptions(subscription_id, user_id, customer_id, status, plan, entitled, event_created)
    values (p_state->>'subscription_id', (p_state->>'user_id')::uuid, p_state->>'customer_id',
      p_state->>'status', p_state->>'plan', (p_state->>'entitled')::boolean, p_created)
    on conflict (subscription_id) do update set status = excluded.status, plan = excluded.plan,
      entitled = excluded.entitled, event_created = excluded.event_created
    where public.stripe_subscriptions.event_created <= excluded.event_created;
  elsif p_kind = 'account' then
    update public.stripe_accounts set charges_enabled = (p_state->>'charges_enabled')::boolean,
      payouts_enabled = (p_state->>'payouts_enabled')::boolean, transfers_enabled = (p_state->>'transfers_enabled')::boolean,
      details_submitted = (p_state->>'details_submitted')::boolean, event_created = p_created
    where account_id = p_state->>'account_id' and event_created <= p_created;
    if not found and not exists (select 1 from public.stripe_accounts where account_id = p_state->>'account_id') then
      raise exception 'Unmapped Stripe account';
    end if;
  end if;
end;
$$;
revoke all on function public.apply_stripe_event(text, bigint, text, jsonb) from public, anon, authenticated;
grant execute on function public.apply_stripe_event(text, bigint, text, jsonb) to service_role;

-- Serialize subscription Checkout creation per user, including concurrent tabs.
create table public.stripe_checkout_attempts (
  user_id uuid primary key references auth.users(id), attempt_id uuid not null default gen_random_uuid(),
  plan text not null check (plan in ('スタンダード', 'プロ')), expires_at timestamptz not null default (now() + interval '25 hours')
);
alter table public.stripe_checkout_attempts enable row level security;
revoke all on public.stripe_checkout_attempts from anon, authenticated;
grant all on public.stripe_checkout_attempts to service_role;
create function public.claim_stripe_checkout(p_user_id uuid, p_plan text)
returns setof public.stripe_checkout_attempts language plpgsql security definer set search_path = '' as $$
begin
  insert into public.stripe_checkout_attempts(user_id, plan) values (p_user_id, p_plan)
  on conflict (user_id) do update set attempt_id = gen_random_uuid(), plan = excluded.plan,
    expires_at = now() + interval '25 hours'
  where public.stripe_checkout_attempts.expires_at < now();
  return query select * from public.stripe_checkout_attempts where user_id = p_user_id;
end;
$$;
revoke all on function public.claim_stripe_checkout(uuid, text) from public, anon, authenticated;
grant execute on function public.claim_stripe_checkout(uuid, text) to service_role;
