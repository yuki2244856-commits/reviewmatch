begin;

create or replace function public.finish_stripe_resource_event(
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
  -- Event IDs are random, not chronological. Distinct same-second events
  -- carry freshly retrieved state and must be allowed through.
  if p_created < lease.event_created
    or (p_created = lease.event_created and p_event_id = lease.event_id) then
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

commit;
