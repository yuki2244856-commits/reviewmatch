-- Preflight (resolve duplicates explicitly; never delete financial history):
-- select contract_id,count(*) from payouts group by contract_id having count(*)>1;
-- select contract_id,count(*) from payments where contract_id is not null group by contract_id having count(*)>1;
begin;
create unique index if not exists payouts_one_per_contract on public.payouts(contract_id);
create unique index if not exists payments_one_per_contract on public.payments(contract_id)
  where contract_id is not null;

-- Keep SECURITY INVOKER RPC and RLS. These checks apply equally to RPC and REST.
-- Only actual database/service sessions (not a client-supplied GUC) bypass checks.
create or replace function public.enforce_transaction_fields() returns trigger
language plpgsql security definer set search_path = '' as $$
declare c public.contracts; v public.conversations; a public.applications;
  expected_fee integer; expected_priority integer; actor uuid := auth.uid();
begin
  if current_setting('role') in ('none', 'service_role') or public.is_admin() then return new; end if;
  if not public.is_approved_user(actor) then raise exception 'Approved user required'; end if;
  if tg_table_name = 'contracts' then
    if tg_op = 'INSERT' then
      select * into v from public.conversations where id = new.conversation_id;
      select * into a from public.applications where id = v.application_id;
      if actor is distinct from v.company_id or new.company_id is distinct from v.company_id
        or new.creator_id is distinct from v.creator_id or new.job_id is distinct from v.job_id
        or new.application_id is distinct from v.application_id
        or a.job_id is distinct from v.job_id or a.creator_id is distinct from v.creator_id
        or not exists(select 1 from public.jobs where id = v.job_id and company_id = actor)
        or not exists(select 1 from public.profiles where id = actor and role = 'company')
        or new.status <> '提示中' or new.amount is null or new.amount not between 0 and 100000000
        or new.deadline is null or nullif(trim(new.deliverable),'') is null
        or length(new.deliverable) > 3000 then raise exception 'Invalid contract proposal'; end if;
      new.created_at := statement_timestamp();
      new.delivery_url := null; new.delivery_message := null;
      new.delivery_at := null; new.review_deadline := null;
    else
      -- Same protection convention as production: restore immutable terms.
      new.id := old.id; new.amount := old.amount; new.company_id := old.company_id;
      new.creator_id := old.creator_id; new.application_id := old.application_id;
      new.conversation_id := old.conversation_id; new.job_id := old.job_id;
      new.deadline := old.deadline; new.deliverable := old.deliverable; new.created_at := old.created_at;
      if new.status is distinct from old.status and not (
        (actor = old.creator_id and old.status = '提示中' and new.status in ('契約成立','辞退')) or
        (actor = old.company_id and old.status = '契約成立' and new.status = '支払済（預かり中）') or
        (actor = old.creator_id and old.status in ('支払済（預かり中）','修正依頼中') and new.status = '納品済（検収中）') or
        (actor = old.company_id and old.status = '納品済（検収中）' and new.status in ('完了','修正依頼中'))
      ) then raise exception 'Invalid contract transition'; end if;
      if new.status = '納品済（検収中）' and old.status in ('支払済（預かり中）','修正依頼中') then
        if new.delivery_url !~ '^https?://' or new.delivery_url is null or length(new.delivery_url)>2000
          or nullif(trim(new.delivery_message),'') is null or length(new.delivery_message)>5000 then
          raise exception 'Invalid delivery'; end if;
        new.delivery_at := statement_timestamp(); new.review_deadline := new.delivery_at + interval '48 hours';
      else
        new.delivery_url := old.delivery_url; new.delivery_message := old.delivery_message;
        new.delivery_at := old.delivery_at; new.review_deadline := old.review_deadline;
      end if;
    end if;
  else
    select * into c from public.contracts where id = new.contract_id for update;
    if tg_table_name = 'payments' then
      -- Plan purchases have no contract and are outside this contract ledger.
      if tg_op = 'UPDATE' then
        if old.contract_id is null and new.contract_id is null then
          if new.kind <> 'プラン' then raise exception 'Contract required'; end if;
          return new;
        end if;
        if (to_jsonb(new) - 'status') is distinct from (to_jsonb(old) - 'status')
          or old.status <> '預かり中' or new.status <> '支払確定' then
          raise exception 'Invalid payment update'; end if;
      elsif new.contract_id is null then
        if new.kind <> 'プラン' then raise exception 'Contract required'; end if;
        return new;
      end if;
      select case when c.amount=0 then 500 else round(c.amount *
        case when j.role like '%SNS運用%' then 0.15 else 0.1 end)::integer end,
        case when j.priority then 2000 else 0 end
        into expected_fee, expected_priority from public.jobs j where j.id = c.job_id;
      if actor is distinct from c.company_id or new.company_id is distinct from c.company_id
        or new.kind <> '案件' or new.amount is distinct from c.amount
        -- Fee terms are fixed when payment is recorded; later job edits must not break approval.
        or (tg_op='INSERT' and (new.fee is distinct from expected_fee
          or new.priority_fee is distinct from expected_priority
          or new.total is distinct from c.amount + expected_fee + expected_priority))
        or (tg_op='INSERT' and (new.status <> '預かり中' or c.status <> '支払済（預かり中）'))
        or (tg_op='UPDATE' and c.status <> '完了') then raise exception 'Invalid contract payment'; end if;
    else
      if tg_op <> 'INSERT' or actor is distinct from c.company_id or c.status <> '完了'
        or new.creator_id is distinct from c.creator_id or new.amount is distinct from c.amount
        or new.status <> '未払い' then raise exception 'Invalid contract payout'; end if;
      new.created_at := least(statement_timestamp(), c.review_deadline);
      new.payout_date := (date_trunc('month', new.created_at at time zone 'Asia/Tokyo')
        + interval '2 months - 1 day')::date;
    end if;
  end if;
  return new;
end;
$$;
create trigger enforce_contract_fields before insert or update on public.contracts
  for each row execute function public.enforce_transaction_fields();
create trigger enforce_payment_fields before insert or update on public.payments
  for each row execute function public.enforce_transaction_fields();
create trigger enforce_payout_fields before insert or update on public.payouts
  for each row execute function public.enforce_transaction_fields();

-- The app sends contracts first, payments second, payouts third. Check final state
-- at commit, after all RPC operations; never trust an RPC-entry flag set by clients.
create or replace function public.check_contract_ledger() returns trigger
language plpgsql security definer set search_path = '' as $$
declare c public.contracts; cid uuid;
begin
  if current_setting('role') in ('none','service_role') or public.is_admin() then return null; end if;
  if tg_table_name='contracts' then cid := new.id; else cid := new.contract_id; end if;
  if cid is null then return null; end if;
  select * into c from public.contracts where id=cid;
  if c.status in ('支払済（預かり中）','納品済（検収中）','修正依頼中','完了') then
    if not exists(select 1 from public.payments p where p.contract_id=c.id
      and p.company_id=c.company_id and p.amount=c.amount
      and p.status=case when c.status='完了' then '支払確定' else '預かり中' end) then
      raise exception 'Contract payment required'; end if;
  end if;
  if c.status='完了' and not exists(select 1 from public.payouts p where p.contract_id=c.id
    and p.creator_id=c.creator_id and p.amount=c.amount) then raise exception 'Contract payout required'; end if;
  return null;
end;
$$;
create constraint trigger check_contract_ledger after insert or update on public.contracts
  deferrable initially deferred for each row execute function public.check_contract_ledger();
create constraint trigger check_payment_ledger after insert or update on public.payments
  deferrable initially deferred for each row execute function public.check_contract_ledger();
create constraint trigger check_payout_ledger after insert or update on public.payouts
  deferrable initially deferred for each row execute function public.check_contract_ledger();
revoke all on function public.enforce_transaction_fields(), public.check_contract_ledger() from public, anon, authenticated;
commit;
