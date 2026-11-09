begin;

create table public.stripe_project_intents (
  id uuid primary key default gen_random_uuid(),
  contract_id uuid not null references public.contracts(id),
  company_id uuid not null references auth.users(id),
  creator_id uuid not null references auth.users(id),
  account_id text not null,
  amount_jpy bigint not null check (amount_jpy >= 0),
  application_fee_jpy bigint not null check (application_fee_jpy >= 0),
  gross_jpy bigint not null check (gross_jpy = amount_jpy + application_fee_jpy),
  kind text not null check (kind in ('direct', 'fee_only')),
  state text not null default 'created' check (state in ('created', 'paid', 'expired', 'canceled', 'refunded')),
  checkout_session_id text unique,
  payment_intent_id text unique,
  charge_id text unique,
  approved_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (account_id, creator_id) references public.stripe_accounts(account_id, user_id),
  check ((kind = 'direct' and amount_jpy > 0) or
    (kind = 'fee_only' and amount_jpy = 0 and application_fee_jpy = 500))
);
create unique index one_active_project_intent on public.stripe_project_intents(contract_id)
  where state in ('created', 'paid');
alter table public.stripe_project_intents enable row level security;
revoke all on public.stripe_project_intents from anon, authenticated;
grant all on public.stripe_project_intents to service_role;
grant select on public.stripe_project_intents to authenticated;
create policy own_project_intent on public.stripe_project_intents for select to authenticated
  using ((select auth.uid()) in (company_id, creator_id));

create function public.claim_project_intent(p_contract_id uuid, p_company_id uuid)
returns public.stripe_project_intents
language plpgsql
security definer
set search_path = ''
as $$
declare
  c public.contracts;
  a public.stripe_accounts;
  i public.stripe_project_intents;
  fee bigint;
begin
  select * into strict c from public.contracts where id = p_contract_id for update;
  if c.company_id <> p_company_id or c.status <> '契約成立'
    or not public.is_approved_user(p_company_id)
    or exists (select 1 from public.stripe_held_orders where contract_id = c.id) then
    raise exception 'Unpaid buyer contract required';
  end if;
  select * into i from public.stripe_project_intents
    where contract_id = c.id and state in ('created', 'paid');
  if found then
    return i;
  end if;
  select * into strict a from public.stripe_accounts where user_id = c.creator_id and api_generation = 'v2';
  if c.amount > 0 and (a.card_payments_status <> 'active' or a.payout_interval <> 'manual'
    or a.exclusive_payout_controls_verified_until is null
    or a.exclusive_payout_controls_verified_until <= now()) then
    raise exception 'Verified active creator required';
  end if;
  select case when c.amount = 0 then 500 else floor(c.amount::double precision *
    case when j.role like '%SNS運用%' then 0.15::double precision else 0.10::double precision end + 0.5)::bigint end
    into strict fee from public.jobs j where j.id = c.job_id;
  insert into public.stripe_project_intents(
    contract_id, company_id, creator_id, account_id, amount_jpy, application_fee_jpy, gross_jpy, kind
  ) values (
    c.id, c.company_id, c.creator_id, a.account_id, c.amount, fee, c.amount + fee,
    case when c.amount = 0 then 'fee_only' else 'direct' end
  ) returning * into i;
  return i;
end;
$$;

create function public.attach_project_session(p_intent_id uuid, p_session_id text) returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  update public.stripe_project_intents set checkout_session_id = p_session_id, updated_at = now()
    where id = p_intent_id and (checkout_session_id is null or checkout_session_id = p_session_id);
  if not found then
    raise exception 'Session mismatch';
  end if;
end;
$$;
create function public.expire_project_intent(p_intent_id uuid, p_session_id text) returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  update public.stripe_project_intents set state = 'expired', checkout_session_id = p_session_id, updated_at = now()
    where id = p_intent_id and state = 'created'
      and (checkout_session_id is null or checkout_session_id = p_session_id);
end;
$$;

-- One transaction commits event receipt, financial evidence, workflow and message.
-- Account advisory locks use the same namespace as refund/approval/payout functions.
create function public.apply_project_payment(
  p_event_id text, p_created bigint, p_intent_id uuid, p_session_id text,
  p_payment_id text, p_facts jsonb
) returns void language plpgsql
security definer
set search_path = ''
as $$
declare
  i public.stripe_project_intents;
  c public.contracts;
begin
  select * into strict i from public.stripe_project_intents where id = p_intent_id;
  perform pg_advisory_xact_lock(hashtextextended(i.account_id, 0));
  select * into strict c from public.contracts where id = i.contract_id for update;
  select * into strict i from public.stripe_project_intents where id = p_intent_id for update;
  if i.checkout_session_id is not null and i.checkout_session_id <> p_session_id then
    raise exception 'Session mismatch';
  end if;
  if i.state = 'refunded' then return; end if;
  insert into public.stripe_events(event_id, created) values (p_event_id, p_created) on conflict do nothing;
  if not found then return; end if;
  if i.state = 'paid' then
    if i.payment_intent_id is distinct from p_payment_id then
    raise exception 'Payment mismatch';
  end if;
    return;
  end if;
  if c.status <> '契約成立' then
    raise exception 'Contract no longer payable';
  end if;
  if i.kind = 'direct' then
    insert into public.stripe_held_orders(
      id, contract_id, company_id, creator_id, account_id, charge_id,
      gross_jpy, application_fee_jpy, processing_fee_jpy, paid_at, available_at, holding_deadline
    ) values (
      i.id, i.contract_id, i.company_id, i.creator_id, i.account_id, p_facts->>'charge_id',
      i.gross_jpy, i.application_fee_jpy, (p_facts->>'processing_fee_jpy')::bigint,
      (p_facts->>'paid_at')::timestamptz, (p_facts->>'available_at')::timestamptz,
      (p_facts->>'holding_deadline')::timestamptz
    );
  end if;
  update public.stripe_project_intents set state = 'paid', checkout_session_id = p_session_id,
    payment_intent_id = p_payment_id, charge_id = p_facts->>'charge_id', updated_at = now() where id = i.id;
  update public.contracts set status = '支払済（預かり中）' where id = c.id and status = '契約成立';
  insert into public.messages(conversation_id, sender_id, kind, body)
    values (c.conversation_id, null, 'system', 'お支払いが完了しました（預かり中）');
end;
$$;

create function public.apply_project_charge_state(
  p_event_id text, p_created bigint, p_order_id uuid, p_state text
) returns void language plpgsql
security definer
set search_path = ''
as $$
declare
  o public.stripe_held_orders;
begin
  select * into strict o from public.stripe_held_orders where id = p_order_id;
  perform pg_advisory_xact_lock(hashtextextended(o.account_id, 0));
  select * into strict o from public.stripe_held_orders where id = p_order_id for update;
  if p_state not in ('refunded', 'disputed', 'held', 'blocked') then
    raise exception 'Invalid charge state';
  end if;
  insert into public.stripe_events(event_id, created) values (p_event_id, p_created) on conflict do nothing;
  if not found or o.state = 'refunded' then return; end if;
  if p_state = 'refunded' then
    if o.state not in ('held', 'refund_pending', 'disputed', 'blocked') or o.approved_at is not null then
      raise exception 'Post approval refund requires reconciliation';
    end if;
    update public.stripe_held_orders set state = 'refunded' where id = o.id;
    update public.stripe_project_intents set state = 'refunded', updated_at = now() where id = o.id;
    update public.contracts set status = '返金済み' where id = o.contract_id;
  elsif p_state = 'held' then
    -- A won dispute can only restore a disputed order, never undo refund/payout/risk blocks.
    update public.stripe_held_orders set state = 'held' where id = o.id and state = 'disputed';
  elsif o.state in ('held', 'disputed') then
    update public.stripe_held_orders set state = p_state where id = o.id;
  else
    raise exception 'Charge risk requires reconciliation';
  end if;
end;
$$;

-- Fencing spans Stripe retrieval through the atomic reducer. Event timestamps are
-- not used to discard independent Checkout/refund events; reducers enforce state.
create function public.finish_project_event(p_key text, p_token uuid, p_action text, p_args jsonb)
returns void language plpgsql
security definer
set search_path = ''
as $$
declare
  lease public.stripe_resource_leases;
  account text;
  intent_id uuid;
begin
  perform pg_advisory_xact_lock(hashtextextended('stripe-resource:' || p_key, 0));
  select * into strict lease from public.stripe_resource_leases where resource_key = p_key for update;
  if p_token is null or lease.token is distinct from p_token or lease.expires_at <= clock_timestamp() then
    raise exception 'Resource lease expired or replaced';
  end if;
  if p_action = 'charge' then
    select account_id into strict account from public.stripe_held_orders where id = (p_args->>'p_order_id')::uuid;
    if p_key <> 'project:' || account then
    raise exception 'Resource mismatch';
  end if;
    perform public.apply_project_charge_state(p_args->>'p_event_id', (p_args->>'p_created')::bigint,
      (p_args->>'p_order_id')::uuid, p_args->>'p_state');
  else
    intent_id := (p_args->>'p_intent_id')::uuid;
    select case when kind = 'direct' then account_id else id::text end into strict account
      from public.stripe_project_intents where id = intent_id;
    if p_key <> 'project:' || account then
    raise exception 'Resource mismatch';
  end if;
    if p_action = 'payment' then
      perform public.apply_project_payment(p_args->>'p_event_id', (p_args->>'p_created')::bigint,
        intent_id, p_args->>'p_session_id', p_args->>'p_payment_id', p_args->'p_facts');
    elsif p_action = 'expire' then
      perform public.expire_project_intent(intent_id, p_args->>'p_session_id');
    else raise exception 'Unknown project action'; end if;
  end if;
end;
$$;

create or replace function public.check_contract_ledger() returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  c public.contracts;
  cid uuid;
  stripe_evidence boolean;
begin
  if current_setting('role') in ('none', 'service_role', 'postgres') or public.is_admin() then
    return null;
  end if;
  if tg_table_name = 'contracts' then cid := new.id; else cid := new.contract_id; end if;
  if cid is null then
    return null;
  end if;
  select * into c from public.contracts where id = cid;
  select exists (
    select 1 from public.stripe_held_orders o where o.contract_id = c.id
      and o.company_id = c.company_id and o.creator_id = c.creator_id
      and o.state in ('held', 'payout_reserved', 'paid_out')
      and (c.status <> '完了' or o.approved_at is not null)
  ) or exists (
    select 1 from public.stripe_project_intents i where i.contract_id = c.id
      and i.company_id = c.company_id and i.creator_id = c.creator_id
      and i.kind = 'fee_only' and i.state = 'paid' and c.amount = 0
      and (c.status <> '完了' or i.approved_at is not null)
  ) into stripe_evidence;
  if stripe_evidence then
    return null;
  end if;
  if c.status in ('支払済（預かり中）', '納品済（検収中）', '修正依頼中', '完了')
    and (exists (select 1 from public.stripe_held_orders where contract_id = c.id)
      or exists (select 1 from public.stripe_project_intents where contract_id = c.id and state in ('paid', 'refunded'))) then
    raise exception 'Valid Stripe ledger required';
  end if;
  if c.status in ('支払済（預かり中）', '納品済（検収中）', '修正依頼中', '完了') then
    if not exists (select 1 from public.payments p where p.contract_id = c.id
      and p.company_id = c.company_id and p.amount = c.amount
      and p.status = case when c.status = '完了' then '支払確定' else '預かり中' end) then
      raise exception 'Contract payment required';
    end if;
  end if;
  if c.status = '完了' and not exists (select 1 from public.payouts p where p.contract_id = c.id
    and p.creator_id = c.creator_id and p.amount = c.amount) then
    raise exception 'Contract payout required';
  end if;
  return null;
end;
$$;

create function public.sync_project_review(p_contract_id uuid, p_revision boolean default false) returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  c public.contracts;
  o public.stripe_held_orders;
begin
  select * into strict c from public.contracts where id = p_contract_id for update;
  if auth.uid() is null or not public.is_approved_user(auth.uid())
    or (p_revision and (auth.uid() <> c.company_id or c.status <> '修正依頼中'))
    or (not p_revision and (auth.uid() <> c.creator_id or c.status <> '納品済（検収中）')) then
    raise exception 'Contract participant and review status required';
  end if;
  select * into o from public.stripe_held_orders where contract_id = c.id;
  if found then
    perform pg_advisory_xact_lock(hashtextextended(o.account_id, 0));
    update public.stripe_held_orders set revision_requested = p_revision,
      delivered_at = case when p_revision then delivered_at else c.delivery_at end
      where id = o.id and state = 'held' and approved_at is null;
    if not found then
    raise exception 'Held unapproved order required';
  end if;
  elsif not exists (select 1 from public.stripe_project_intents
    where contract_id = c.id and kind = 'fee_only' and state = 'paid' and approved_at is null) then
    raise exception 'Paid project required';
  end if;
end;
$$;

-- Close the gap between the authenticated workflow transaction and its RPC retry.
-- No client-provided timestamps or held-order writes are accepted.
create function public.sync_project_review_transition() returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.status is distinct from old.status and new.status in ('納品済（検収中）', '修正依頼中')
    and (exists (select 1 from public.stripe_held_orders where contract_id = new.id)
      or exists (select 1 from public.stripe_project_intents where contract_id = new.id and state = 'paid')) then
    perform public.sync_project_review(new.id, new.status = '修正依頼中');
  end if;
  return new;
end;
$$;
create trigger sync_project_review_transition after update on public.contracts
  for each row execute function public.sync_project_review_transition();

create function public.approve_project_fee(p_contract_id uuid) returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  c public.contracts;
begin
  select * into strict c from public.contracts where id = p_contract_id for update;
  if auth.uid() is distinct from c.company_id or not public.is_approved_user(auth.uid())
    or c.status not in ('納品済（検収中）', '完了') or c.delivery_at is null then
    raise exception 'Buyer review required';
  end if;
  update public.stripe_project_intents set approved_at = coalesce(approved_at, now()), updated_at = now()
    where contract_id = c.id and kind = 'fee_only' and state = 'paid';
  if not found then
    raise exception 'Paid fee required';
  end if;
end;
$$;

-- Recheck delivery/approval under the account lock, even when retrying refund_pending.
create or replace function public.request_held_refund(p_order_id uuid) returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  o public.stripe_held_orders;
begin
  select * into strict o from public.stripe_held_orders where id = p_order_id;
  perform pg_advisory_xact_lock(hashtextextended(o.account_id, 0));
  select * into strict o from public.stripe_held_orders where id = p_order_id for update;
  if o.state not in ('held', 'refund_pending') or o.delivered_at is not null or o.approved_at is not null
    or exists (select 1 from public.contracts where id = o.contract_id and delivery_at is not null)
    or exists (select 1 from public.stripe_payout_batches where account_id = o.account_id
      and state in ('reserved', 'submitted', 'uncertain')) then
    raise exception 'Only pre-delivery cancellation supported';
  end if;
  update public.stripe_held_orders set state = 'refund_pending' where id = p_order_id;
end;
$$;

create function public.complete_project_reviews(p_now timestamptz default now()) returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  c public.contracts;
  n integer := 0;
begin
  -- Lock contract rows before selecting eligible approvals, excluding revision requests.
  for c in select * from public.contracts where status = '納品済（検収中）'
    and delivery_at + interval '48 hours' <= p_now order by id for update skip locked
  loop
    perform public.auto_approve_held_orders(p_now);
    update public.stripe_project_intents set approved_at = c.delivery_at + interval '48 hours', updated_at = now()
      where contract_id = c.id and kind = 'fee_only' and state = 'paid' and approved_at is null;
    if exists (select 1 from public.stripe_held_orders where contract_id = c.id and state = 'held'
      and approved_at is not null and not revision_requested)
      or exists (select 1 from public.stripe_project_intents where contract_id = c.id
        and kind = 'fee_only' and state = 'paid' and approved_at is not null) then
      update public.contracts set status = '完了' where id = c.id;
      insert into public.messages(conversation_id, sender_id, kind, body) values
        (c.conversation_id, null, 'system', '48時間経過により自動承認されました。契約完了（報酬確定）');
      n := n + 1;
    end if;
  end loop;
  return n;
end;
$$;
select cron.schedule('reviewmatch-project-auto-approval', '0 * * * *',
  'select public.complete_project_reviews();');

revoke all on function public.claim_project_intent(uuid, uuid), public.attach_project_session(uuid, text),
  public.expire_project_intent(uuid, text), public.apply_project_payment(text, bigint, uuid, text, text, jsonb),
  public.apply_project_charge_state(text, bigint, uuid, text), public.complete_project_reviews(timestamptz),
  public.sync_project_review_transition(), public.finish_project_event(text, uuid, text, jsonb) from public, anon, authenticated;
grant execute on function public.claim_project_intent(uuid, uuid), public.attach_project_session(uuid, text),
  public.expire_project_intent(uuid, text), public.apply_project_payment(text, bigint, uuid, text, text, jsonb),
  public.apply_project_charge_state(text, bigint, uuid, text), public.complete_project_reviews(timestamptz) to service_role;
revoke all on function public.sync_project_review(uuid, boolean), public.approve_project_fee(uuid) from public, anon;
grant execute on function public.sync_project_review(uuid, boolean), public.approve_project_fee(uuid) to authenticated;
revoke execute on function public.apply_project_payment(text, bigint, uuid, text, text, jsonb),
  public.apply_project_charge_state(text, bigint, uuid, text) from service_role;
grant execute on function public.finish_project_event(text, uuid, text, jsonb) to service_role;
commit;
