-- Run these checks BEFORE applying. Resolve duplicates explicitly; this migration never deletes rows.
-- select job_id, creator_id, count(*) from public.applications
--   group by job_id, creator_id having count(*) > 1;
-- select conversation_id, count(*) from public.contracts
--   where conversation_id is not null and status not in ('辞退', '完了')
--   group by conversation_id having count(*) > 1;
begin;
alter table public.applications add constraint applications_job_creator_unique
  unique (job_id, creator_id);
-- Terminal statuses found in respondToContract/completeDelivery: 辞退 and 完了.
create unique index contracts_one_active_per_conversation on public.contracts(conversation_id)
  where status not in ('辞退', '完了');
commit;
