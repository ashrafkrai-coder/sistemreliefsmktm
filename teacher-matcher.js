export function normalizeTeacherName(name) {
  return name
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .trim()
    .replace(/\s+/g, ' ')
    .toLocaleLowerCase('ms');
}

function getInitials(name) {
  return normalizeTeacherName(name)
    .replace(/\ba\s*\/\s*[lp]\b/g, ' ')
    .split(/[^a-z]+/)
    .filter((word) => word && !['bin', 'binti', 'bt', 'al', 'ap'].includes(word))
    .map((word) => word[0])
    .join('');
}

function throwAmbiguousName(fullName) {
  throw new Error(
    `Nama "${fullName}" sepadan dengan beberapa guru. Gunakan nama yang lebih khusus dalam mesej Telegram.`
  );
}

export function findTeacherByName(fullName, teachers, aliases = new Map()) {
  // Strip common Malay honorifics ("En Peer" -> "peer") so the title itself
  // never has to match a word in the teacher's actual name.
  const searchName = normalizeTeacherName(fullName).replace(
    /^(en|cik|pn|puan|tuan|ustaz|ustazah|cikgu)\s+/,
    ''
  );

  const alias = aliases.get(searchName);
  if (alias) {
    const aliasMatch = teachers.find(
      (teacher) => normalizeTeacherName(teacher.full_name) === normalizeTeacherName(alias)
    );
    if (aliasMatch) return aliasMatch;
  }

  const exactMatches = teachers.filter(
    (teacher) => normalizeTeacherName(teacher.full_name) === searchName
  );
  if (exactMatches.length === 1) return exactMatches[0];

  const partialMatches = teachers.filter((teacher) =>
    normalizeTeacherName(teacher.full_name)
      .split(' ')
      .some((part) => part.startsWith(searchName))
  );
  if (partialMatches.length === 1) return partialMatches[0];
  if (partialMatches.length > 1) throwAmbiguousName(fullName);

  if (searchName.includes(' ')) {
    const phraseMatches = teachers.filter((teacher) =>
      normalizeTeacherName(teacher.full_name).includes(searchName)
    );
    if (phraseMatches.length === 1) return phraseMatches[0];
    if (phraseMatches.length > 1) throwAmbiguousName(fullName);

    // Every search word must prefix-match some word in the teacher's name.
    const searchWords = searchName.split(' ');
    const wordSetMatches = teachers.filter((teacher) => {
      const nameWords = normalizeTeacherName(teacher.full_name).split(' ');
      return searchWords.every((word) => nameWords.some((part) => part.startsWith(word)));
    });
    if (wordSetMatches.length === 1) return wordSetMatches[0];
    if (wordSetMatches.length > 1) throwAmbiguousName(fullName);
  }

  const compactInitials = searchName.replace(/[^a-z]/g, '');
  const initialTokens = searchName.split(/\s+/);
  const isInitialism =
    /^[a-z]{2,5}$/.test(searchName) ||
    (searchName.includes(' ') &&
      initialTokens.length >= 2 &&
      initialTokens.every((word) => /^[a-z]\.?$/.test(word)));
  if (isInitialism && compactInitials.length >= 2) {
    const initialMatches = teachers.filter((teacher) =>
      getInitials(teacher.full_name).startsWith(compactInitials)
    );
    if (initialMatches.length === 1) return initialMatches[0];
    if (initialMatches.length > 1) throwAmbiguousName(fullName);
  }

  // Last resort for a short name embedded inside a compound word.
  const substringMatches = teachers.filter((teacher) =>
    normalizeTeacherName(teacher.full_name)
      .split(' ')
      .some((part) => part.includes(searchName))
  );
  if (substringMatches.length === 1) return substringMatches[0];
  if (substringMatches.length > 1) throwAmbiguousName(fullName);

  throw new Error(
    `Nama "${fullName}" tiada dalam senarai guru Supabase. Semak ejaan atau tambah guru melalui senarai rasmi.`
  );
}
