begin;
-- A durable fenced lease spans the network retrieve and the final DB transaction.
-- Transaction advisory locks alone cannot span separate PostgREST calls.
create table public.stripe_resource_leases (
  resource_key text primary key,
  token uuid,
  expires_at timestamptz,
  event_created bigint not null default -1,
  event_id text not null default ''
);
alter table public.stripe_resource_leases enable row level security;
revoke all on public.stripe_resource_leases from public, anon, authenticated;
grant all on public.stripe_resource_leases to service_role;

create function public.claim_stripe_resource(p_key text) returns uuid
language plpgsql security definer set search_path = '' as $$
declare claimed uuid;
begin
  if p_key is null or p_key = '' then raise exception 'Missing resource key'; end if;
  insert into public.stripe_resource_leases(resource_key, token, expires_at)
    values (p_key, gen_random_uuid(), clock_timestamp() + interval '60 seconds')
  on conflict (resource_key) do update
    set token = gen_random_uuid(), expires_at = clock_timestamp() + interval '60 seconds'
    where public.stripe_resource_leases.expires_at <= clock_timestamp()
       or public.stripe_resource_leases.token is null
  returning token into claimed;
  if claimed is null then raise exception 'Resource busy; retry event'; end if;
  return claimed;
end;
$$;
create function public.release_stripe_resource(p_key text, p_token uuid) returns void
language sql security definer set search_path = '' as $$
  update public.stripe_resource_leases set token = null, expires_at = null
    where resource_key = p_key and token = p_token;
$$;

-- All three state reducers are now callable only through this fenced, ordered entry point.
revoke execute on function public.apply_stripe_event(text,bigint,text,jsonb),
  public.apply_stripe_merchant_event(text,bigint,text,text),
  public.apply_held_payout_result(text,bigint,text,uuid,text,bigint,text) from service_role;
create function public.finish_stripe_resource_event(
  p_key text, p_token uuid, p_event_id text, p_created bigint, p_kind text, p_state jsonb
) returns boolean
language plpgsql security definer set search_path = '' as $$
declare lease public.stripe_resource_leases;
begin
  perform pg_advisory_xact_lock(hashtextextended('stripe-resource:' || p_key, 0));
  select * into strict lease from public.stripe_resource_leases
    where resource_key = p_key for update;
  if lease.token is distinct from p_token or p_token is null
    or lease.expires_at <= clock_timestamp() then
    raise exception 'Resource lease expired or replaced';
  end if;
  if (p_created, p_event_id collate "C") <= (lease.event_created, lease.event_id collate "C") then
    return false;
  end if;
  if p_kind = 'subscription' and p_key = 'subscription:' || (p_state->>'subscription_id') then
    perform public.apply_stripe_event(p_event_id, p_created, 'subscription', p_state);
  elsif p_kind = 'account' and p_key = 'account:' || (p_state->>'account_id') then
    perform public.apply_stripe_merchant_event(p_event_id, p_created,
      p_state->>'account_id', p_state->>'card_status');
  elsif p_kind = 'payout' and p_key = 'payout:' || (p_state->>'account_id') || ':' || (p_state->>'payout_id') then
    perform public.apply_held_payout_result(p_event_id, p_created,
      p_state->>'account_id', (p_state->>'batch_id')::uuid,
      p_state->>'payout_id', (p_state->>'amount')::bigint, p_state->>'status');
  else
    raise exception 'Resource kind/key mismatch';
  end if;
  update public.stripe_resource_leases set event_created = p_created, event_id = p_event_id
    where resource_key = p_key;
  return true;
end;
$$;
revoke all on function public.claim_stripe_resource(text),
  public.release_stripe_resource(text,uuid),
  public.finish_stripe_resource_event(text,uuid,text,bigint,text,jsonb) from public, anon, authenticated;
grant execute on function public.claim_stripe_resource(text),
  public.release_stripe_resource(text,uuid),
  public.finish_stripe_resource_event(text,uuid,text,bigint,text,jsonb) to service_role;
commit;
