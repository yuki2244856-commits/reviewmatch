-- Commit a workflow diff as one transaction, with the caller's existing grants/RLS.
-- This does not grant new table privileges or replace domain-specific RLS/constraints.
create function public.apply_reviewmatch_workflow(p_operations jsonb)
returns void language plpgsql security invoker set search_path = '' as $$
declare op jsonb; tbl text; vals jsonb; allowed text; cols text; expressions text;
  assignments text; affected integer;
begin
  if auth.uid() is null then raise exception 'Sign in required'; end if;
  if jsonb_typeof(p_operations) is distinct from 'array'
    or jsonb_array_length(p_operations) > 500 then raise exception 'Invalid workflow'; end if;
  -- Also serialize concurrent tabs for one caller. Cross-party contract transitions use CAS below.
  perform pg_advisory_xact_lock(hashtextextended('workflow:' || auth.uid()::text, 0));
  for op in select value from jsonb_array_elements(p_operations) loop
    tbl := op->>'table'; vals := op->'values';
    allowed := case tbl
      when 'applications' then 'id job_id creator_id message portfolio_url status created_at'
      when 'conversations' then 'id application_id job_id company_id creator_id created_at'
      when 'contracts' then 'id application_id conversation_id job_id company_id creator_id amount deadline deliverable status delivery_url delivery_message delivery_at review_deadline created_at'
      when 'subscriptions' then 'id user_id plan status trial_used trial_end_date next_renewal_date'
      when 'payments' then 'id contract_id company_id kind plan amount fee priority_fee total status created_at'
      when 'payouts' then 'id contract_id creator_id amount status payout_date created_at'
      when 'messages' then 'id conversation_id sender_id kind body contract_id read_by created_at'
      when 'notifications' then 'id user_id kind conversation_id is_read created_at'
      else null end;
    if allowed is null or jsonb_typeof(vals) is distinct from 'object'
      or vals = '{}'::jsonb or op->>'id' is null
      or jsonb_typeof(op->'insert') is distinct from 'boolean' then
      raise exception 'Invalid workflow operation';
    end if;
    if exists (select 1 from jsonb_object_keys(vals) k where not (k = any(string_to_array(allowed, ' ')))) then
      raise exception 'Invalid workflow column';
    end if;
    if (op->>'insert')::boolean then
      if vals->>'id' is distinct from op->>'id' then raise exception 'Invalid insert identity'; end if;
      select string_agg(format('%I', k), ', ' order by k),
        string_agg(format('(jsonb_populate_record(null::public.%I, $1)).%I', tbl, k), ', ' order by k)
      into cols, expressions from jsonb_object_keys(vals) k;
      execute format('insert into public.%I (%s) select %s', tbl, cols, expressions) using vals;
    else
      if vals ? 'id' then raise exception 'Cannot change workflow identity'; end if;
      select string_agg(format('%I = (jsonb_populate_record(null::public.%I, $1)).%I', k, tbl, k), ', ' order by k)
      into assignments from jsonb_object_keys(vals) k;
      if tbl = 'contracts' then
        if op->>'previous_status' is null then raise exception 'Contract status required'; end if;
        execute format('update public.%I set %s where id = $2::uuid and status = $3', tbl, assignments)
          using vals, op->>'id', op->>'previous_status';
      else
        execute format('update public.%I set %s where id = $2::uuid', tbl, assignments)
          using vals, op->>'id';
      end if;
      get diagnostics affected = row_count;
      if affected <> 1 then raise exception 'Workflow changed or access denied; reload and retry'; end if;
    end if;
  end loop;
end;
$$;
revoke all on function public.apply_reviewmatch_workflow(jsonb) from public, anon;
grant execute on function public.apply_reviewmatch_workflow(jsonb) to authenticated;
