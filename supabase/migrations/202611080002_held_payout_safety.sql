-- Keep allocations identical to the eligible sum, including revision exclusions.
create or replace function public.reserve_held_payout(p_account_id text, p_now timestamptz default now())
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
    select id,b.id,net_jpy from public.stripe_held_orders where account_id = p_account_id and state = 'held' and not revision_requested
      and approved_at <= p_now and due_on <= (p_now at time zone 'Asia/Tokyo')::date
      and available_at <= p_now and holding_deadline > p_now;
  update public.stripe_held_orders set state = 'payout_reserved' where id in
    (select order_id from public.stripe_payout_allocations where batch_id = b.id);
  return b;
end;
$$;

-- Account changes require fresh proof of exclusive payout control and reconciliation.
create or replace function public.apply_stripe_merchant_event(p_event_id text, p_created bigint, p_account_id text, p_card_status text)
returns void language plpgsql security definer set search_path = '' as $$
begin
  insert into public.stripe_events(event_id, created) values (p_event_id, p_created) on conflict do nothing;
  if not found then return; end if;
  if not exists (select 1 from public.stripe_accounts where account_id = p_account_id and api_generation = 'v2') then
    raise exception 'Unmapped merchant account';
  end if;
  update public.stripe_accounts set card_payments_status = p_card_status, event_created = p_created,
    exclusive_payout_controls_verified_until = null, funds_reconciled_at = null
    where account_id = p_account_id and api_generation = 'v2' and event_created <= p_created;
end;
$$;
