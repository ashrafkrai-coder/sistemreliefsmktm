const ACTIVE_STATUSES = ['assigned', 'completed'];

// Administrative staff who should never be suggested as a relief teacher.
const EXCLUDED_FROM_RELIEF = new Set(['LILY JULIANI BINTI JAAFAR']);

export function isoDateToDayOfWeek(isoDate) {
  const date = new Date(`${isoDate}T00:00:00.000Z`);
  return date.getUTCDay() || 7;
}

function scoreCandidate(teacher, subjectName, reliefLoad) {
  const normalizeSubject = (value) =>
    String(value ?? '')
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .trim()
      .toLocaleLowerCase('ms');
  const targetSubject = normalizeSubject(subjectName);
  const optionSubjects = String(teacher.option_subject ?? '')
    .split(/[,;/|]/)
    .map(normalizeSubject);
  const subjectMatch = Boolean(
    targetSubject && optionSubjects.includes(targetSubject)
  );
  const score = Math.max(0, 100 - reliefLoad * 10) + (subjectMatch ? 20 : 0);
  const reason = subjectMatch
    ? `Opsyen ${subjectName} · Beban relief ${reliefLoad}x`
    : `Beban relief semasa ${reliefLoad}x`;
  return { subjectMatch, score, reason };
}

/**
 * Builds relief suggestions for every timetable slot left empty by teachers
 * absent on `absenceDate`, ranked by fairness (relief load) and subject option.
 */
export async function generateReliefSuggestions(supabaseClient, absenceDate) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(absenceDate)) {
    throw new TypeError('Tarikh relief mesti dalam format YYYY-MM-DD.');
  }
  const dayOfWeek = isoDateToDayOfWeek(absenceDate);
  const parsedDate = new Date(`${absenceDate}T00:00:00.000Z`);
  if (
    Number.isNaN(parsedDate.valueOf()) ||
    parsedDate.toISOString().slice(0, 10) !== absenceDate
  ) {
    throw new TypeError('Tarikh relief tidak sah.');
  }

  const [absenceResult, teacherResult, timetableResult] = await Promise.all([
    supabaseClient
      .from('daily_absences')
      .select('id, teacher_id, category, remark, is_partial_day, available_from, available_to, teachers!inner(id, full_name)')
      .eq('absence_date', absenceDate),
    supabaseClient.from('teachers').select('id, full_name, option_subject'),
    supabaseClient
      .from('master_timetable')
      .select('id, teacher_id, class_name, period_slot, subject_name, room_name')
      .eq('day_of_week', dayOfWeek),
  ]);

  if (absenceResult.error) throw absenceResult.error;
  if (teacherResult.error) throw teacherResult.error;
  if (timetableResult.error) throw timetableResult.error;

  const absences = absenceResult.data ?? [];
  if (absences.length === 0) {
    return { slots: [], warnings: ['Tiada rekod ketidakhadiran untuk tarikh ini.'] };
  }

  const allTeachers = teacherResult.data ?? [];
  const dayTimetable = timetableResult.data ?? [];

  const absentTeacherIds = new Set(absences.map((absence) => absence.teacher_id));
  const absenceByTeacherId = new Map(absences.map((absence) => [absence.teacher_id, absence]));

  const busyByPeriod = new Map();
  for (const row of dayTimetable) {
    if (!busyByPeriod.has(row.period_slot)) busyByPeriod.set(row.period_slot, new Set());
    busyByPeriod.get(row.period_slot).add(row.teacher_id);
  }

  const rawSlots = dayTimetable
    .filter((row) => absentTeacherIds.has(row.teacher_id))
    .sort(
      (first, second) =>
        String(first.period_slot).localeCompare(String(second.period_slot), undefined, {
          numeric: true,
        }) ||
        String(first.class_name).localeCompare(String(second.class_name), 'ms')
    );
  if (rawSlots.length === 0) {
    return {
      slots: [],
      warnings: ['Guru yang tidak hadir hari ini tiada waktu mengajar dalam jadual waktu utama.'],
    };
  }

  const absenceIds = absences.map((absence) => absence.id);
  const { data: existingAssignments, error: assignmentError } = await supabaseClient
    .from('relief_assignments')
    .select('absence_id, period_slot, status, relief_teacher_id')
    .in('absence_id', absenceIds)
    .in('status', ACTIVE_STATUSES);
  if (assignmentError) throw assignmentError;

  const coveredKeys = new Set(
    (existingAssignments ?? []).map((row) => `${row.absence_id}|${row.period_slot}`)
  );
  const occupiedReliefKeys = new Set(
    (existingAssignments ?? []).map(
      (row) => `${row.relief_teacher_id}|${row.period_slot}`
    )
  );

  const teacherIds = allTeachers.map((teacher) => teacher.id);
  const { data: loadCounts, error: loadError } =
    teacherIds.length > 0
      ? await supabaseClient.rpc('get_relief_load_counts', { p_teacher_ids: teacherIds })
      : { data: [], error: null };
  if (loadError) throw loadError;

  const loadByTeacherId = new Map(
    (loadCounts ?? []).map((row) => [row.relief_teacher_id, Number(row.relief_count)])
  );

  const warnings = [];
  const partialDayWarned = new Set();
  const slots = [];

  for (const row of rawSlots) {
    const absence = absenceByTeacherId.get(row.teacher_id);
    const key = `${absence.id}|${row.period_slot}`;
    if (coveredKeys.has(key)) continue;

    if (absence.is_partial_day && !partialDayWarned.has(absence.id)) {
      partialDayWarned.add(absence.id);
      warnings.push(
        `${absence.teachers.full_name} hanya tidak hadir separuh hari (${absence.available_from ?? '-'} – ${
          absence.available_to ?? '-'
        }). Semak sendiri period mana yang benar-benar perlu diganti.`
      );
    }

    const busy = busyByPeriod.get(row.period_slot) ?? new Set();
    const candidates = allTeachers
      .filter(
        (teacher) =>
          teacher.id !== row.teacher_id &&
          !absentTeacherIds.has(teacher.id) &&
          !busy.has(teacher.id) &&
          !occupiedReliefKeys.has(`${teacher.id}|${row.period_slot}`) &&
          !EXCLUDED_FROM_RELIEF.has(teacher.full_name)
      )
      .map((teacher) => {
        const reliefLoad = loadByTeacherId.get(teacher.id) ?? 0;
        const { score, reason, subjectMatch } = scoreCandidate(teacher, row.subject_name, reliefLoad);
        return {
          teacher_id: teacher.id,
          teacher_name: teacher.full_name,
          relief_load: reliefLoad,
          subject_match: subjectMatch,
          score,
          reason,
        };
      })
      .sort((a, b) => b.score - a.score || a.teacher_name.localeCompare(b.teacher_name, 'ms'));

    if (candidates.length === 0) {
      warnings.push(
        `Tiada guru ganti tersedia untuk ${absence.teachers.full_name} (${row.class_name}, period ${row.period_slot}).`
      );
    }

    slots.push({
      timetable_id: row.id,
      absence_id: absence.id,
      original_teacher_id: row.teacher_id,
      original_teacher_name: absence.teachers.full_name,
      absence_category: absence.category,
      absence_remark: absence.remark ?? '',
      class_name: row.class_name,
      period_slot: row.period_slot,
      subject_name: row.subject_name,
      room_name: row.room_name ?? '',
      candidates,
    });

    const bestCandidate = candidates[0];
    if (bestCandidate) {
    occupiedReliefKeys.add(`${bestCandidate.teacher_id}|${row.period_slot}`);
    loadByTeacherId.set(
      bestCandidate.teacher_id,
      (loadByTeacherId.get(bestCandidate.teacher_id) ?? 0) + 1
    );
    }
  }

  slots.sort(
    (a, b) =>
      String(a.period_slot).localeCompare(String(b.period_slot), undefined, { numeric: true }) ||
      a.original_teacher_name.localeCompare(b.original_teacher_name, 'ms')
  );

  if (slots.length === 0 && warnings.length === 0) {
    warnings.push('Semua slot kelas bagi tarikh ini sudah mempunyai cadangan atau tugasan relief.');
  }

  return { slots, warnings };
}
