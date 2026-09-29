const ABSENCE_CATEGORIES = new Set([
  'MC',
  'CUTI SAKIT MC',
  'CRK',
  'LAIN LAIN CUTI',
]);

function normalizeCategory(category) {
  return String(category ?? '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLocaleUpperCase('ms')
    .replace(/[^A-Z0-9]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

export function countDashboardAbsences(absences, today) {
  return absences.filter(
    (absence) =>
      absence.date === today && ABSENCE_CATEGORIES.has(normalizeCategory(absence.category))
  ).length;
}

export function countTeachersNeedingRelief(absences, today) {
  return new Set(
    absences
      .filter((absence) => absence.date === today)
      .map((absence) =>
        String(absence.teacher ?? '')
          .normalize('NFD')
          .replace(/[\u0300-\u036f]/g, '')
          .trim()
          .replace(/\s+/g, ' ')
          .toLocaleLowerCase('ms')
      )
      .filter(Boolean)
  ).size;
}
