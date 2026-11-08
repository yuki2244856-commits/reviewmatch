-- Read-only operator report; no automatic approval, payout or refund.
create function public.held_orders_near_deadline(p_now timestamptz default now())
returns table (
  order_id uuid, contract_id uuid, account_id text, state text,
  approved_at timestamptz, holding_deadline timestamptz, remaining interval
)
language sql stable security definer set search_path = '' as $$
  select o.id, o.contract_id, o.account_id, o.state,
    o.approved_at, o.holding_deadline, o.holding_deadline - p_now
  from public.stripe_held_orders o
  where o.state not in ('refunded', 'paid_out')
    and o.holding_deadline < p_now + interval '81 days'
  order by o.holding_deadline, o.id;
$$;
revoke all on function public.held_orders_near_deadline(timestamptz) from public, anon, authenticated;
grant execute on function public.held_orders_near_deadline(timestamptz) to service_role;
