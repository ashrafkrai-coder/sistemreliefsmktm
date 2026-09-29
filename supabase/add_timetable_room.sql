-- Run once in Supabase Dashboard > SQL Editor to add room data to an existing timetable.
alter table public.master_timetable
  add column if not exists room_name text;
