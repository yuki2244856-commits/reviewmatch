-- Demo contracts only. Stripe-owned held orders have a separate, disabled lifecycle.
begin;
create function public.auto_approve_expired_reviews() returns integer
language plpgsql security definer set search_path = '' as $$
declare
  c public.contracts;
  payment_id uuid;
  approved integer := 0;
begin
  -- The row lock/CAS also serializes with apply_reviewmatch_workflow's contract update.
  for c in
    select * from public.contracts
    where status = '納品済（検収中）' and review_deadline <= now()
    order by id for update skip locked
  loop
    select p.id into payment_id from public.payments p
      where p.contract_id = c.id and p.status = '預かり中'
      order by p.id limit 1 for update;
    if payment_id is null
      or exists (select 1 from public.payouts where contract_id = c.id)
      or exists (select 1 from public.stripe_held_orders where contract_id = c.id) then
      continue;
    end if;
    update public.contracts set status = '完了'
      where id = c.id and status = '納品済（検収中）';
    if not found then continue; end if;
    update public.payments set status = '支払確定' where id = payment_id;
    insert into public.payouts(contract_id, creator_id, amount, status, payout_date, created_at)
    values (c.id, c.creator_id, c.amount, '未払い',
      (date_trunc('month', c.review_deadline at time zone 'Asia/Tokyo')
        + interval '2 months - 1 day')::date, c.review_deadline);
    if c.conversation_id is not null then
      insert into public.messages(conversation_id, sender_id, kind, body)
      values (c.conversation_id, null, 'system',
        '48時間経過により自動承認されました。契約完了（報酬確定）');
    end if;
    if c.creator_id is not null then
      insert into public.notifications(user_id, kind, conversation_id)
      values (c.creator_id, 'contract', c.conversation_id);
    end if;
    approved := approved + 1;
  end loop;
  return approved;
end;
$$;
revoke all on function public.auto_approve_expired_reviews() from public, anon, authenticated;
grant execute on function public.auto_approve_expired_reviews() to service_role;

create extension if not exists pg_cron;
select cron.schedule('reviewmatch-demo-auto-approval', '0 * * * *',
  'select public.auto_approve_expired_reviews();');
commit;
