begin;
create table public.stripe_payout_worker_leases (
  account_id text primary key references public.stripe_accounts(account_id),
  token uuid not null, expires_at timestamptz not null
);
alter table public.stripe_payout_worker_leases enable row level security;
revoke all on public.stripe_payout_worker_leases from public, anon, authenticated;
grant all on public.stripe_payout_worker_leases to service_role;

create function public.claim_payout_worker(p_account_id text) returns uuid
language plpgsql security definer set search_path = '' as $$
declare claimed uuid;
begin
  perform pg_advisory_xact_lock(hashtextextended(p_account_id, 0));
  -- Even an expired worker may have reached Stripe. Never steal its lease automatically.
  insert into public.stripe_payout_worker_leases(account_id, token, expires_at)
    values (p_account_id, gen_random_uuid(), clock_timestamp() + interval '2 minutes')
    on conflict do nothing returning token into claimed;
  if claimed is null then raise exception 'Worker busy or expired; reconcile before recovery'; end if;
  return claimed;
end;
$$;

create function public.payout_worker_evidence(p_account_id text, p_token uuid, p_batch_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare a public.stripe_accounts; evidence jsonb;
begin
  perform pg_advisory_xact_lock(hashtextextended(p_account_id, 0));
  if not exists (select 1 from public.stripe_payout_worker_leases
    where account_id = p_account_id and token = p_token and expires_at > clock_timestamp()) then
    raise exception 'Worker lease expired or replaced';
  end if;
  select * into strict a from public.stripe_accounts where account_id = p_account_id for update;
  if a.payout_interval <> 'manual' or a.exclusive_payout_controls_verified_until is null
    or a.exclusive_payout_controls_verified_until <= clock_timestamp()
    or a.funds_reconciled_at is null
    or a.funds_reconciled_at < clock_timestamp() - interval '15 minutes'
    or a.funds_reconciled_at > clock_timestamp() then
    raise exception 'Payout evidence expired';
  end if;
  if exists (select 1 from public.stripe_held_orders where account_id = p_account_id
    and (state in ('refund_pending', 'disputed', 'blocked')
      or (state in ('held', 'payout_reserved') and holding_deadline <= clock_timestamp()))) then
    raise exception 'Account risk or holding deadline requires review';
  end if;
  if not exists (select 1 from public.stripe_payout_batches where id = p_batch_id
    and account_id = p_account_id and state = 'reserved' and stripe_payout_id is null
    and created_at > clock_timestamp() - interval '23 hours') then
    raise exception 'Reserved batch required';
  end if;
  select jsonb_build_object(
    'account', to_jsonb(a),
    'batch', (select to_jsonb(b) from public.stripe_payout_batches b where id = p_batch_id),
    'orders', (select jsonb_agg(to_jsonb(o) order by o.id) from public.stripe_held_orders o
      where o.account_id = p_account_id),
    'allocations', (select jsonb_agg(to_jsonb(x) order by x.order_id)
      from public.stripe_payout_allocations x where batch_id = p_batch_id)
  ) into evidence;
  return evidence;
end;
$$;
create function public.assert_payout_worker_evidence(
  p_account_id text, p_token uuid, p_batch_id uuid, p_evidence jsonb
) returns void language plpgsql security definer set search_path = '' as $$
begin
  if public.payout_worker_evidence(p_account_id, p_token, p_batch_id) is distinct from p_evidence then
    raise exception 'Payout evidence changed';
  end if;
end;
$$;
create function public.finish_payout_worker(
  p_account_id text, p_token uuid, p_batch_id uuid, p_evidence jsonb, p_payout_id text
) returns void language plpgsql security definer set search_path = '' as $$
begin
  perform public.assert_payout_worker_evidence(p_account_id, p_token, p_batch_id, p_evidence);
  update public.stripe_payout_batches set state = 'submitted', stripe_payout_id = p_payout_id
    where id = p_batch_id and account_id = p_account_id and state = 'reserved';
  delete from public.stripe_payout_worker_leases where account_id = p_account_id and token = p_token;
end;
$$;
-- Error paths deliberately retain the lease. Manual recovery must reconcile Stripe and DB first.
revoke all on function public.claim_payout_worker(text),
  public.payout_worker_evidence(text,uuid,uuid),
  public.assert_payout_worker_evidence(text,uuid,uuid,jsonb),
  public.finish_payout_worker(text,uuid,uuid,jsonb,text) from public, anon, authenticated;
grant execute on function public.claim_payout_worker(text),
  public.payout_worker_evidence(text,uuid,uuid),
  public.assert_payout_worker_evidence(text,uuid,uuid,jsonb),
  public.finish_payout_worker(text,uuid,uuid,jsonb,text) to service_role;
commit;
