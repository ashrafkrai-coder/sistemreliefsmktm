-- Sistem Pintar Penggantian Guru SMK Taman Medan
-- Run once in Supabase Dashboard > SQL Editor.

create extension if not exists pgcrypto;

create table if not exists public.teachers (
  id uuid primary key default gen_random_uuid(),
  full_name text not null,
  phone text,
  option_subject text
);

create table if not exists public.master_timetable (
  id uuid primary key default gen_random_uuid(),
  teacher_id uuid not null references public.teachers(id) on delete restrict,
  class_name text not null,
  day_of_week smallint not null check (day_of_week between 1 and 7),
  period_slot text not null,
  subject_name text not null,
  room_name text
);

alter table public.master_timetable
  add column if not exists room_name text;

create table if not exists public.daily_absences (
  id uuid primary key default gen_random_uuid(),
  teacher_id uuid not null references public.teachers(id) on delete restrict,
  absence_date date not null,
  category text not null,
  remark text,
  is_partial_day boolean not null default false,
  available_from time,
  available_to time,
  check (
    (is_partial_day and (available_from is not null or available_to is not null))
    or (not is_partial_day and available_from is null and available_to is null)
  )
);

create table if not exists public.relief_assignments (
  id uuid primary key default gen_random_uuid(),
  absence_id uuid not null references public.daily_absences(id) on delete cascade,
  period_slot text not null,
  class_name text not null,
  original_teacher_id uuid not null references public.teachers(id) on delete restrict,
  relief_teacher_id uuid not null references public.teachers(id) on delete restrict,
  status text not null default 'suggested'
    check (status in ('suggested', 'assigned', 'completed', 'cancelled'))
);

create index if not exists idx_master_timetable_day_period
  on public.master_timetable (day_of_week, period_slot);
create index if not exists idx_master_timetable_teacher_day_period
  on public.master_timetable (teacher_id, day_of_week, period_slot);
create index if not exists idx_daily_absences_date_teacher
  on public.daily_absences (absence_date, teacher_id);
create index if not exists idx_daily_absences_teacher_date
  on public.daily_absences (teacher_id, absence_date);
create index if not exists idx_relief_assignments_absence_period_status
  on public.relief_assignments (absence_id, period_slot, status);
create index if not exists idx_relief_assignments_teacher_status
  on public.relief_assignments (relief_teacher_id, status);

alter table public.teachers enable row level security;
alter table public.master_timetable enable row level security;
alter table public.daily_absences enable row level security;
alter table public.relief_assignments enable row level security;

grant usage on schema public to authenticated;
grant select, insert, update, delete on
  public.teachers,
  public.master_timetable,
  public.daily_absences,
  public.relief_assignments
to authenticated;

drop policy if exists "School staff manage teachers" on public.teachers;
create policy "School staff manage teachers"
  on public.teachers for all to authenticated
  using (true) with check (true);

drop policy if exists "School staff manage timetable" on public.master_timetable;
create policy "School staff manage timetable"
  on public.master_timetable for all to authenticated
  using (true) with check (true);

drop policy if exists "School staff manage absences" on public.daily_absences;
create policy "School staff manage absences"
  on public.daily_absences for all to authenticated
  using (true) with check (true);

drop policy if exists "School staff manage relief assignments" on public.relief_assignments;
create policy "School staff manage relief assignments"
  on public.relief_assignments for all to authenticated
  using (true) with check (true);

create or replace function public.get_relief_load_counts(p_teacher_ids uuid[])
returns table (relief_teacher_id uuid, relief_count bigint)
language sql
stable
security invoker
set search_path = public
as $$
  select ra.relief_teacher_id, count(*) as relief_count
  from public.relief_assignments ra
  where ra.relief_teacher_id = any(p_teacher_ids)
    and ra.status in ('assigned', 'completed')
  group by ra.relief_teacher_id;
$$;

revoke all on function public.get_relief_load_counts(uuid[]) from public, anon;
grant execute on function public.get_relief_load_counts(uuid[]) to authenticated;
