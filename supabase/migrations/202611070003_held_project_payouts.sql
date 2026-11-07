-- LOCAL starter only. New tables are service-owned verified snapshots, not browser-written demo finance.
alter table public.stripe_accounts add column exclusive_payout_controls_verified_until timestamptz;
alter table public.stripe_accounts add column payout_interval text not null default 'unverified';
alter table public.stripe_accounts add column funds_reconciled_at timestamptz;
alter table public.stripe_accounts add column reconciled_available_jpy bigint not null default 0;
alter table public.stripe_accounts add column external_reserve_jpy bigint not null default 0 check (external_reserve_jpy >= 0);

create function public.held_payout_due_date(approved_at timestamptz) returns date
language sql immutable set search_path = '' as $$
  select (date_trunc('month', approved_at at time zone 'Asia/Tokyo') + interval '2 months - 1 day')::date;
$$;
alter table public.stripe_accounts add constraint stripe_account_creator_pair unique (account_id,user_id);
create table public.stripe_held_orders (
  id uuid primary key default gen_random_uuid(), contract_id uuid not null unique,
  company_id uuid not null references auth.users(id), creator_id uuid not null references auth.users(id),
  account_id text not null references public.stripe_accounts(account_id),
  charge_id text not null unique, gross_jpy bigint not null check (gross_jpy > 0),
  application_fee_jpy bigint not null check (application_fee_jpy >= 0),
  processing_fee_jpy bigint not null check (processing_fee_jpy >= 0),
  net_jpy bigint generated always as (gross_jpy - application_fee_jpy - processing_fee_jpy) stored,
  paid_at timestamptz not null, available_at timestamptz not null, holding_deadline timestamptz not null,
  state text not null default 'held' check (state in ('held','refund_pending','refunded','disputed','blocked','payout_reserved','paid_out')),
  delivered_at timestamptz, revision_requested boolean not null default false,
  approved_at timestamptz, approval_method text check (approval_method in ('manual','automatic')),
  due_on date,
  foreign key (account_id,creator_id) references public.stripe_accounts(account_id,user_id),
  check (account_id <> 'acct_1UZ6DL3azRRJUDzk'),
  check (gross_jpy > application_fee_jpy + processing_fee_jpy),
  check (holding_deadline > paid_at), check (available_at >= paid_at),
  check ((approved_at is null and due_on is null and approval_method is null) or
         (approved_at is not null and due_on is not null and due_on = public.held_payout_due_date(approved_at) and approval_method is not null))
);
create table public.stripe_payout_batches (
  id uuid primary key default gen_random_uuid(), account_id text not null references public.stripe_accounts(account_id),
  amount_jpy bigint not null check (amount_jpy > 0), reserve_jpy bigint not null check (reserve_jpy >= 0),
  state text not null default 'reserved' check (state in ('reserved','submitted','uncertain','paid','canceled')),
  stripe_payout_id text unique, created_at timestamptz not null default now()
);
create unique index one_active_held_payout_per_account on public.stripe_payout_batches(account_id)
  where state in ('reserved','submitted','uncertain');
create table public.stripe_payout_allocations (
  order_id uuid primary key references public.stripe_held_orders(id),
  batch_id uuid not null references public.stripe_payout_batches(id), amount_jpy bigint not null check (amount_jpy > 0)
);
alter table public.stripe_held_orders enable row level security;
alter table public.stripe_payout_batches enable row level security;
alter table public.stripe_payout_allocations enable row level security;
revoke all on public.stripe_held_orders, public.stripe_payout_batches, public.stripe_payout_allocations from anon, authenticated;
grant all on public.stripe_held_orders, public.stripe_payout_batches, public.stripe_payout_allocations to service_role;
grant select on public.stripe_held_orders to authenticated;
create policy own_held_order on public.stripe_held_orders for select to authenticated
  using ((select auth.uid()) in (company_id, creator_id));

-- Same advisory account lock must be used for all payment/refund/dispute/reconciliation mutations.
create function public.approve_held_order(p_order_id uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare o public.stripe_held_orders;
begin
  select * into strict o from public.stripe_held_orders where id = p_order_id;
  perform pg_advisory_xact_lock(hashtextextended(o.account_id, 0));
  select * into strict o from public.stripe_held_orders where id = p_order_id for update;
  if auth.uid() is null or auth.uid() <> o.company_id then raise exception 'Buyer approval required'; end if;
  if o.state <> 'held' or o.delivered_at is null or o.revision_requested or o.holding_deadline <= now() then
    raise exception 'Order cannot be approved';
  end if;
  if o.approved_at is not null then return; end if;
  update public.stripe_held_orders set approved_at = now(), approval_method = 'manual',
    due_on = public.held_payout_due_date(now()) where id = p_order_id;
end;
$$;
revoke all on function public.approve_held_order(uuid) from public, anon;
grant execute on function public.approve_held_order(uuid) to authenticated, service_role;

-- Service-only clock argument permits deterministic local testing; no browser can set this clock.
create function public.auto_approve_held_orders(p_now timestamptz default now()) returns integer
language plpgsql security definer set search_path = '' as $$
declare o public.stripe_held_orders; n integer := 0;
begin
  for o in select * from public.stripe_held_orders where state = 'held' and approved_at is null
    and delivered_at is not null and not revision_requested and delivered_at + interval '48 hours' <= p_now
    and holding_deadline > p_now order by account_id, id
  loop
    perform pg_advisory_xact_lock(hashtextextended(o.account_id, 0));
    update public.stripe_held_orders set approved_at = delivered_at + interval '48 hours', approval_method = 'automatic',
      due_on = public.held_payout_due_date(delivered_at + interval '48 hours')
    where id = o.id and state = 'held' and approved_at is null and not revision_requested
      and delivered_at + interval '48 hours' <= p_now and holding_deadline > p_now;
    if found then n := n + 1; end if;
  end loop;
  return n;
end;
$$;
revoke all on function public.auto_approve_held_orders(timestamptz) from public, anon, authenticated;
grant execute on function public.auto_approve_held_orders(timestamptz) to service_role;

create function public.reserve_held_payout(p_account_id text, p_now timestamptz default now())
returns public.stripe_payout_batches language plpgsql security definer set search_path = '' as $$
declare a public.stripe_accounts; b public.stripe_payout_batches; total bigint; reserve bigint;
begin
  perform pg_advisory_xact_lock(hashtextextended(p_account_id, 0));
  select * into strict a from public.stripe_accounts where account_id = p_account_id for update;
  if a.payout_interval <> 'manual' or a.exclusive_payout_controls_verified_until is null
    or a.exclusive_payout_controls_verified_until <= p_now or a.funds_reconciled_at is null
    or a.funds_reconciled_at < p_now - interval '15 minutes' or a.funds_reconciled_at > p_now then
    raise exception 'Fresh reconciliation and exclusive manual payout control required';
  end if;
  if exists (select 1 from public.stripe_held_orders where account_id = p_account_id
    and (state in ('refund_pending','disputed','blocked') or (state = 'held' and holding_deadline <= p_now))) then
    raise exception 'Account risk or holding deadline requires review';
  end if;
  select * into b from public.stripe_payout_batches where account_id = p_account_id and state in ('reserved','submitted','uncertain');
  if found then return b; end if; -- replay the same durable batch, never allocate again

  select coalesce(sum(net_jpy),0) into total from public.stripe_held_orders
    where account_id = p_account_id and state = 'held' and not revision_requested and approved_at <= p_now
      and due_on <= (p_now at time zone 'Asia/Tokyo')::date and available_at <= p_now and holding_deadline > p_now;
  if total <= 0 then raise exception 'No approved due funds'; end if;
  -- Conservative refund reserve: preserve unapproved/not-due proceeds and all outstanding processing fees.
  select coalesce(sum(case when revision_requested or approved_at is null or due_on > (p_now at time zone 'Asia/Tokyo')::date
    or available_at > p_now then net_jpy else 0 end),0) + coalesce(sum(processing_fee_jpy),0)
    + a.external_reserve_jpy into reserve from public.stripe_held_orders where account_id = p_account_id and state = 'held';
  if total > a.reconciled_available_jpy - reserve then raise exception 'Insufficient unreserved creator balance'; end if;
  insert into public.stripe_payout_batches(account_id, amount_jpy, reserve_jpy) values (p_account_id,total,reserve) returning * into b;
  insert into public.stripe_payout_allocations(order_id,batch_id,amount_jpy)
    select id,b.id,net_jpy from public.stripe_held_orders where account_id = p_account_id and state = 'held'
      and approved_at <= p_now and due_on <= (p_now at time zone 'Asia/Tokyo')::date
      and available_at <= p_now and holding_deadline > p_now;
  update public.stripe_held_orders set state = 'payout_reserved' where id in
    (select order_id from public.stripe_payout_allocations where batch_id = b.id);
  return b;
end;
$$;
revoke all on function public.reserve_held_payout(text,timestamptz) from public, anon, authenticated;
grant execute on function public.reserve_held_payout(text,timestamptz) to service_role;

create function public.request_held_refund(p_order_id uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare o public.stripe_held_orders;
begin
  select * into strict o from public.stripe_held_orders where id = p_order_id;
  perform pg_advisory_xact_lock(hashtextextended(o.account_id, 0));
  select * into strict o from public.stripe_held_orders where id = p_order_id for update;
  if o.state = 'refund_pending' then return; end if;
  if o.state <> 'held' or exists (select 1 from public.stripe_payout_batches where account_id = o.account_id
    and state in ('reserved','submitted','uncertain')) then raise exception 'Payout in flight; stop and reconcile before refund'; end if;
  update public.stripe_held_orders set state = 'refund_pending' where id = p_order_id;
end;
$$;
revoke all on function public.request_held_refund(uuid) from public, anon, authenticated;
grant execute on function public.request_held_refund(uuid) to service_role;

create function public.apply_held_payout_result(p_event_id text, p_created bigint, p_account_id text,
  p_batch_id uuid, p_payout_id text, p_amount bigint, p_status text) returns void
language plpgsql security definer set search_path = '' as $$
declare b public.stripe_payout_batches;
begin
  perform pg_advisory_xact_lock(hashtextextended(p_account_id, 0));
  select * into strict b from public.stripe_payout_batches where id = p_batch_id and account_id = p_account_id for update;
  if b.amount_jpy <> p_amount or (b.stripe_payout_id is not null and b.stripe_payout_id <> p_payout_id) then
    raise exception 'Payout allocation mismatch';
  end if;
  insert into public.stripe_events(event_id, created) values (p_event_id,p_created) on conflict do nothing;
  if not found then return; end if;
  if p_status = 'paid' then
    update public.stripe_payout_batches set state = 'paid', stripe_payout_id = p_payout_id where id = b.id;
    update public.stripe_held_orders set state = 'paid_out' where state = 'payout_reserved'
      and id in (select order_id from public.stripe_payout_allocations where batch_id = b.id);
  elsif p_status in ('failed','canceled') then
    update public.stripe_payout_batches set state = 'uncertain', stripe_payout_id = p_payout_id where id = b.id;
    update public.stripe_accounts set funds_reconciled_at = null where account_id = p_account_id;
    update public.stripe_held_orders set state = 'blocked' where
      id in (select order_id from public.stripe_payout_allocations where batch_id = b.id);
  elsif b.state <> 'paid' then
    update public.stripe_payout_batches set state = 'submitted', stripe_payout_id = p_payout_id where id = b.id;
  end if;
end;
$$;
revoke all on function public.apply_held_payout_result(text,bigint,text,uuid,text,bigint,text) from public, anon, authenticated;
grant execute on function public.apply_held_payout_result(text,bigint,text,uuid,text,bigint,text) to service_role;
