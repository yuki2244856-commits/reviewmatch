-- Record the production defenses verified on 2026-11-08. Safe to reapply.
begin;
create or replace function public.protect_profiles_fields() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if not public.is_admin() then
    new.role := old.role;
    new.status := old.status;
    new.review_note := old.review_note;
  end if;
  return new;
end;
$$;
drop trigger if exists trg_protect_profiles on public.profiles;
create trigger trg_protect_profiles before update on public.profiles
  for each row execute function public.protect_profiles_fields();
create or replace function public.protect_creator_profiles_fields() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if not public.is_admin() then
    new.user_id := old.user_id;
    new.certified := old.certified;
    new.rating := old.rating;
  end if;
  return new;
end;
$$;
drop trigger if exists trg_protect_creator_profiles on public.creator_profiles;
create trigger trg_protect_creator_profiles before update on public.creator_profiles
  for each row execute function public.protect_creator_profiles_fields();
create or replace function public.protect_jobs_fields() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if not public.is_admin() then
    new.created_at := old.created_at;
  end if;
  return new;
end;
$$;
drop trigger if exists trg_protect_jobs on public.jobs;
create trigger trg_protect_jobs before update on public.jobs
  for each row execute function public.protect_jobs_fields();
drop policy if exists jobs_update on public.jobs;
create policy jobs_update on public.jobs for update to authenticated
  using ((auth.uid() = company_id) OR public.is_admin());

create or replace function public.protect_messages_fields() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if not public.is_admin() then
    -- Preserve all content, including future columns. Only append the caller's receipt.
    new := old;
    if not (auth.uid() = any(coalesce(old.read_by, '{}'::uuid[]))) then
      new.read_by := array_append(coalesce(old.read_by, '{}'::uuid[]), auth.uid());
    end if;
  end if;
  return new;
end;
$$;
drop trigger if exists trg_protect_messages on public.messages;
create trigger trg_protect_messages before update on public.messages
  for each row execute function public.protect_messages_fields();
commit;
