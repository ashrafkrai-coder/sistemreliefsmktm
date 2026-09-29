const DAYS = new Map([
  ['ISNIN', 1], ['MONDAY', 1],
  ['SELASA', 2], ['TUESDAY', 2],
  ['RABU', 3], ['WEDNESDAY', 3],
  ['KHAMIS', 4], ['THURSDAY', 4],
  ['JUMAAT', 5], ['FRIDAY', 5],
  ['SABTU', 6], ['SATURDAY', 6],
  ['AHAD', 7], ['SUNDAY', 7],
]);

const CATEGORIES = [
  { pattern: /\bTUGASAN\s+LUAR/i, value: 'TUGASAN LUAR' },
  { pattern: /\bCUTI\s+SAKIT(?:\s*\(\s*MC\s*\))?/i, value: 'CUTI SAKIT (MC)' },
  { pattern: /\bCUTI\s+KUARANTIN/i, value: 'CUTI KUARANTIN' },
  { pattern: /\bCUTI\s+BERSALIN/i, value: 'CUTI BERSALIN' },
  { pattern: /\bTEMUJANJI\s+HOSPITAL/i, value: 'TEMUJANJI HOSPITAL' },
  { pattern: /\bLAIN[- ]LAIN\s+CUTI/i, value: 'LAIN-LAIN CUTI' },
  { pattern: /\bCTR\b/i, value: 'CTR' },
  { pattern: /\bCRK\b/i, value: 'CRK' },
  { pattern: /\bLAIN[- ]LAIN\s+URUSAN/i, value: 'LAIN-LAIN URUSAN' },
];

const TIME_TOKEN =
  String.raw`\d{1,2}(?:[:.]\d{2})?\s*(?:pagi|tengah\s*hari|tengahari|petang|malam|am|pm)?`;

function normalizeDay(day) {
  const normalized = day
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toUpperCase()
    .trim();
  return DAYS.get(normalized) ?? null;
}

function toIsoDate(day, month, year) {
  const date = new Date(Date.UTC(year, month - 1, day));
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    throw new Error(`Tarikh tidak sah: ${day}/${month}/${year}.`);
  }

  return date.toISOString().slice(0, 10);
}

function parseClock(token) {
  const match = token.match(
    /^(\d{1,2})(?:[:.](\d{2}))?\s*(pagi|tengah\s*hari|tengahari|petang|malam|am|pm)?$/i
  );
  if (!match) return null;

  let hour = Number(match[1]);
  const minute = Number(match[2] ?? 0);
  const meridiem = (match[3] ?? '').toLowerCase();
  if (minute > 59 || hour > 23) return null;

  if (['pm', 'petang', 'malam'].includes(meridiem)) {
    if (hour < 12) hour += 12;
  } else if (meridiem === 'am' || meridiem === 'pagi') {
    if (hour === 12) hour = 0;
  } else if (meridiem.startsWith('tengah') && hour < 12) {
    hour += 12;
  }

  return { hour, minute, hasMeridiem: Boolean(meridiem) };
}

function formatClock({ hour, minute }) {
  return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}:00`;
}

const DATE_LIKE_PATTERN = /\b\d{1,2}\s*(?:[-–—]\s*\d{1,2}\s*)?\/\s*\d{1,2}\b/g;

function extractTimeWindow(remark) {
  const searchText = remark.replace(DATE_LIKE_PATTERN, '');

  const rangePattern = new RegExp(
    `(${TIME_TOKEN})\\s*(?:-|–|—|hingga|sampai)\\s*(${TIME_TOKEN})`,
    'i'
  );
  const range = searchText.match(rangePattern);

  if (range) {
    const start = parseClock(range[1].trim());
    const end = parseClock(range[2].trim());
    if (!start || !end) return null;

    if (!end.hasMeridiem && end.hour < start.hour && end.hour <= 7) {
      end.hour += 12;
    }

    return {
      is_partial_day: true,
      available_from: formatClock(start),
      available_to: formatClock(end),
    };
  }

  const single = searchText.match(new RegExp(TIME_TOKEN, 'i'));
  if (!single) {
    return { is_partial_day: false, available_from: null, available_to: null };
  }

  const time = parseClock(single[0].trim());
  if (!time) return null;

  if (/\b(masuk|kembali)\b/i.test(remark)) {
    return {
      is_partial_day: true,
      available_from: null,
      available_to: formatClock(time),
    };
  }

  return {
    is_partial_day: true,
    available_from: formatClock(time),
    available_to: null,
  };
}

function categoryInLine(line) {
  for (const category of CATEGORIES) {
    const match = category.pattern.exec(line);
    if (match) {
      return {
        category: category.value,
        remainder: line.replace(category.pattern, '').replace(/^\s*[:\-]\s*/, '').trim(),
      };
    }
  }
  return null;
}

const NAME_RUN_PATTERN =
  /^[\p{L}\p{M}][\p{L}\p{M}.'’]*(?:\s+[\p{L}\p{M}][\p{L}\p{M}.'’]*)*/u;

function parseTeacherLine(line, category, absenceDate, dayOfWeek, dayLabel) {
  const cleaned = line.replace(/^\s*(?:[-•●]\s*|\d+\s*[.)-]\s*)+/, '').trim();
  if (!cleaned) return null;

  // Teacher name is the leading run of letter-only words; everything after
  // belongs to the remark, whether or not a "-"/":" separator is present.
  // This handles both "Name - catatan" and bare "Name" lines (common under
  // sections like CTR/CRK where no remark text is expected), as well as names
  // directly followed by a date with no separator ("Sakinah 28-30/9 ...").
  const nameMatch = cleaned.match(NAME_RUN_PATTERN);
  if (!nameMatch) return null;

  const fullyConsumedLine = nameMatch[0].length === cleaned.length;
  const wordCount = nameMatch[0].trim().split(/\s+/).length;
  // A run that swallowed the whole line with no punctuation to stop it is
  // only plausible as a short bare name (e.g. "Nur Ikmal"); anything longer
  // is almost certainly a sentence of instructions, not a teacher's name.
  // A run that stopped partway (hit a digit, dash, slash, comma, ...) has
  // more room, since real "Name - catatan" lines can have a 3-4 word name.
  if (wordCount > (fullyConsumedLine ? 2 : 4)) return null;

  const teacherName = nameMatch[0].trim().replace(/^[*_`]+|[*_`]+$/g, '');
  if (!teacherName || teacherName.length > 120) return null;

  let remark = cleaned.slice(nameMatch[0].length).trim();
  remark = remark.replace(/^[-–—:]\s*/, '').trim().replace(/^[*_`]+|[*_`]+$/g, '');

  const times = remark
    ? extractTimeWindow(remark)
    : { is_partial_day: false, available_from: null, available_to: null };
  if (!times) {
    throw new Error(`Format masa tidak sah untuk ${teacherName}: "${remark}".`);
  }

  return {
    absence_date: absenceDate,
    day_of_week: dayOfWeek,
    day_label: dayLabel,
    teacher_name: teacherName,
    category,
    remark,
    ...times,
  };
}

export function parseTelegramReliefText(telegramText) {
  if (typeof telegramText !== 'string' || !telegramText.trim()) {
    throw new TypeError('Tampal mesej Telegram terlebih dahulu.');
  }

  const dateMatch = telegramText.match(
    /\bTARIKH\s*[:\-]\s*(\d{1,2})[\/.-](\d{1,2})[\/.-](\d{4})/i
  );
  if (!dateMatch) {
    throw new Error('Tarikh tidak ditemui. Gunakan format TARIKH : dd/mm/yyyy.');
  }

  const absenceDate = toIsoDate(
    Number(dateMatch[1]),
    Number(dateMatch[2]),
    Number(dateMatch[3])
  );
  const dayMatch = telegramText.match(/\bHARI\s*[:\-]\s*([\p{L}]+)/iu);
  const dayLabel = dayMatch?.[1]?.toUpperCase() ?? null;
  const statedDay = dayLabel ? normalizeDay(dayLabel) : null;
  if (dayLabel && !statedDay) {
    throw new Error(`Nama hari tidak dikenali: "${dayLabel}".`);
  }

  const dateObject = new Date(`${absenceDate}T00:00:00.000Z`);
  const dayOfWeek = dateObject.getUTCDay() || 7;
  const entries = [];
  let currentCategory = 'LAIN-LAIN URUSAN';
  let seenCategoryHeader = false;

  for (const rawLine of telegramText.split(/\r?\n/)) {
    let line = rawLine.trim();
    if (!line || /^(?:TARIKH|HARI)\s*[:\-]/i.test(line)) continue;

    const category = categoryInLine(line);
    if (category) {
      currentCategory = category.category;
      seenCategoryHeader = true;
      line = category.remainder;
      if (!line) continue;
    }

    // Preamble/postamble instructions (before the first category header, e.g.
    // "Mohon guru-guru segera untuk rekod...") are never teacher entries.
    if (!seenCategoryHeader) continue;

    const entry = parseTeacherLine(
      line,
      currentCategory,
      absenceDate,
      dayOfWeek,
      dayLabel
    );
    if (entry) entries.push(entry);
  }

  if (entries.length === 0) {
    throw new Error('Tiada baris guru ditemui. Gunakan format “Nama Guru - catatan”.');
  }

  if (statedDay && statedDay !== dayOfWeek) {
    const expected = [...DAYS.entries()].find(([, value]) => value === dayOfWeek)?.[0];
    for (const entry of entries) {
      entry.day_warning = `Hari mesej (${dayLabel}) tidak sepadan dengan tarikh; tarikh jatuh pada ${expected}.`;
    }
  }

  return entries;
}
