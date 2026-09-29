import { parseTelegramReliefText } from './telegram-parser.js';
import { generateReliefSuggestions } from './relief-engine.js';
import { findTeacherByName, normalizeTeacherName } from './teacher-matcher.js';
import {
  countDashboardAbsences,
  countTeachersNeedingRelief,
} from './dashboard-summary.js';

const STORAGE_KEY = 'relief-pintar.absences.v1';
const form = document.querySelector('#absence-form');
const list = document.querySelector('#absence-list');
const emptyState = document.querySelector('#empty-state');
const message = document.querySelector('#app-message');
const installButton = document.querySelector('#install-button');
const connectionStatus = document.querySelector('#connection-status');
const dateInput = form.elements.date;
const authForm = document.querySelector('#auth-form');
const signedInPanel = document.querySelector('#signed-in-panel');
const supabaseStatus = document.querySelector('#supabase-status');
const supabaseHelp = document.querySelector('#supabase-help');
const authDialog = document.querySelector('#auth-dialog');
const authOpenButton = document.querySelector('#auth-open-button');
const telegramForm = document.querySelector('#telegram-form');
const telegramText = document.querySelector('#telegram-text');
const telegramMessage = document.querySelector('#telegram-message');
const telegramPreview = document.querySelector('#telegram-preview');
const telegramPreviewBody = document.querySelector('#telegram-preview-body');
const importButton = document.querySelector('#import-button');
const reliefForm = document.querySelector('#relief-form');
const reliefDateInput = document.querySelector('#relief-date');
const reliefMessage = document.querySelector('#relief-message');
const reliefResults = document.querySelector('#relief-results');
const reliefPrintResults = document.querySelector('#relief-print-results');
const reliefWarnings = document.querySelector('#relief-warnings');
const saveReliefButton = document.querySelector('#save-relief-button');
const exportPdfButton = document.querySelector('#export-pdf-button');
const tabButtons = document.querySelectorAll('.tab-button');
const tabPanels = document.querySelectorAll('.tab-panel');

let absences = loadAbsences().filter((absence) => !absence.remote_id);
let installPrompt;
let supabaseClient;
let currentSession;
let telegramEntries = [];
let reliefSuggestions = [];

function localDateString(date = new Date()) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function loadAbsences() {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '[]');
    return Array.isArray(saved) ? saved : [];
  } catch (error) {
    console.error('Tidak dapat membaca rekod setempat.', error);
    return [];
  }
}

function saveAbsences() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(absences));
  } catch (error) {
    console.error('Tidak dapat menyimpan rekod setempat.', error);
    message.textContent = 'Cache peranti gagal disimpan. Semak ruang storan pelayar.';
  }
}

function showLocalMode() {
  currentSession = null;
  supabaseStatus.textContent = supabaseClient ? 'Belum log masuk' : 'Peranti sahaja';
  authOpenButton.hidden = !supabaseClient;
  authForm.hidden = !supabaseClient;
  signedInPanel.hidden = true;
  supabaseHelp.textContent = 'Gunakan akaun staf yang telah dijemput oleh pentadbir sekolah.';
}

async function loadRemoteAbsences() {
  const { data, error } = await supabaseClient
    .from('daily_absences')
    .select('id, absence_date, category, remark, is_partial_day, available_from, available_to, teachers!inner(full_name)')
    .order('absence_date', { ascending: false });

  if (error) throw error;

  const remoteRecords = (data ?? []).map((row) => ({
    id: row.id,
    remote_id: row.id,
    teacher: row.teachers.full_name,
    date: row.absence_date,
    category: row.category,
    remark: row.remark ?? '',
    is_partial_day: row.is_partial_day,
    available_from: row.available_from,
    available_to: row.available_to,
  }));
  const pendingRecords = absences.filter((record) => !record.remote_id);

  absences = [...remoteRecords, ...pendingRecords];
  saveAbsences();
  render();
}

const TEACHER_NAME_ALIASES = new Map([
  ['pengetua', 'LILY JULIANI BINTI JAAFAR'],
  ['pn pengetua', 'LILY JULIANI BINTI JAAFAR'],
  ['puan pengetua', 'LILY JULIANI BINTI JAAFAR'],
  ['dalilah', 'NORDALILA HAZIRAH BT MOHAMMAD'],
]);

async function ensureRemoteTeacher(fullName) {
  const { data: teachers, error: lookupError } = await supabaseClient
    .from('teachers')
    .select('id, full_name');

  if (lookupError) throw lookupError;
  return findTeacherByName(fullName, teachers ?? [], TEACHER_NAME_ALIASES);
}

async function syncAbsence(absence) {
  const canonicalTeacherName = TEACHER_NAME_ALIASES.get(
    normalizeTeacherName(absence.teacher)
  );
  if (canonicalTeacherName) absence.teacher = canonicalTeacherName;

  const teacher = await ensureRemoteTeacher(absence.teacher);
  absence.teacher = teacher.full_name;
  const { data, error } = await supabaseClient
    .from('daily_absences')
    .upsert({
      id: absence.id,
      teacher_id: teacher.id,
      absence_date: absence.date,
      category: absence.category,
      remark: absence.remark || null,
      is_partial_day: absence.is_partial_day ?? false,
      available_from: absence.available_from ?? null,
      available_to: absence.available_to ?? null,
    }, { onConflict: 'id' })
    .select('id')
    .single();

  if (error) throw error;
  absence.remote_id = data.id;
  saveAbsences();
}

async function syncPendingAbsences() {
  const pendingRecords = absences.filter((record) => !record.remote_id);
  const failures = [];
  let succeeded = 0;
  for (const record of pendingRecords) {
    try {
      await syncAbsence(record);
      succeeded += 1;
    } catch (error) {
      console.error(`Gagal menyegerakkan rekod ${record.teacher}.`, error);
      failures.push(`${record.teacher}: ${error.message}`);
    }
  }
  return { succeeded, failures };
}

async function activateSession(session) {
  if (!session) {
    absences = absences.filter((absence) => !absence.remote_id);
    saveAbsences();
    render();
    showLocalMode();
    return;
  }

  currentSession = session;
  supabaseStatus.textContent = 'Disambungkan';
  authOpenButton.hidden = true;
  authForm.hidden = true;
  signedInPanel.hidden = false;
  if (authDialog.open) authDialog.close();
  document.querySelector('#signed-in-email').textContent = session.user.email;

  try {
    await loadRemoteAbsences();
    const { succeeded, failures } = await syncPendingAbsences();
    if (failures.length === 0) {
      message.textContent = 'Rekod ketidakhadiran berjaya disegerakkan dengan Supabase.';
    } else if (succeeded > 0) {
      message.textContent = `Penyegerakan sebahagian: ${succeeded} rekod berjaya, ${failures.length} gagal (${failures.join('; ')}).`;
    } else {
      message.textContent = `Penyegerakan gagal untuk semua ${failures.length} rekod (${failures.join('; ')}).`;
    }
  } catch (error) {
    console.error('Gagal menyegerakkan data Supabase.', error);
    message.textContent = `Penyegerakan gagal: ${error.message}`;
  }
}

async function configureSupabase() {
  let config;
  try {
    config = await import('/supabase-config.js');
  } catch (error) {
    if (error instanceof TypeError || error.message.includes('Failed to fetch')) {
      absences = absences.filter((absence) => !absence.remote_id);
      showLocalMode();
      return;
    }
    console.error('Tidak dapat membaca konfigurasi Supabase.', error);
    showLocalMode();
    return;
  }

  if (!config.supabaseUrl || !config.supabaseAnonKey) {
    showLocalMode();
    return;
  }

  try {
    const { createClient } = await import(
      'https://esm.sh/@supabase/supabase-js@2'
    );
    supabaseClient = createClient(config.supabaseUrl, config.supabaseAnonKey, {
      auth: { persistSession: true, autoRefreshToken: true },
    });
    supabaseStatus.textContent = 'Belum log masuk';
    authOpenButton.hidden = false;
    authForm.hidden = false;

    const { data, error } = await supabaseClient.auth.getSession();
    if (error) throw error;
    await activateSession(data.session);

    supabaseClient.auth.onAuthStateChange((_event, session) => {
      window.setTimeout(() => {
        activateSession(session).catch((error) => {
          console.error('Tidak dapat mengaktifkan sesi Supabase.', error);
          message.textContent = `Sesi Supabase gagal: ${error.message}`;
        });
      }, 0);
    });
  } catch (error) {
    console.error('Tidak dapat memulakan sambungan Supabase.', error);
    supabaseStatus.textContent = 'Sambungan gagal';
    supabaseHelp.textContent = `Semak konfigurasi dan capaian rangkaian. ${error.message}`;
    authOpenButton.hidden = true;
    authForm.hidden = true;
  }
}

function renderTelegramPreview() {
  telegramPreviewBody.replaceChildren();
  const existingKeys = new Set(
    absences.map((absence) => `${normalizeTeacherName(absence.teacher)}|${absence.date}`)
  );
  const batchKeys = new Set();
  let duplicateCount = 0;

  telegramEntries.forEach((entry, index) => {
    const key = `${normalizeTeacherName(entry.teacher_name)}|${entry.absence_date}`;
    const duplicate = existingKeys.has(key) || batchKeys.has(key);
    batchKeys.add(key);
    if (duplicate) duplicateCount += 1;

    const row = document.createElement('tr');
    const selectCell = document.createElement('td');
    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.checked = !duplicate;
    checkbox.disabled = duplicate;
    checkbox.dataset.index = String(index);
    checkbox.setAttribute('aria-label', `Pilih rekod ${entry.teacher_name}`);
    selectCell.append(checkbox);

    const values = [
      entry.teacher_name,
      formatDate(entry.absence_date),
      entry.category,
      entry.remark,
    ];
    row.append(selectCell);
    for (const value of values) {
      const cell = document.createElement('td');
      cell.textContent = value;
      row.append(cell);
    }
    if (entry.day_warning) row.classList.add('has-warning');
    telegramPreviewBody.append(row);
  });

  telegramPreview.hidden = telegramEntries.length === 0;
  importButton.disabled =
    telegramEntries.length === 0 ||
    !telegramPreviewBody.querySelector('input[type="checkbox"]:checked');
  const date = telegramEntries[0]?.absence_date;
  const warning = telegramEntries.find((entry) => entry.day_warning)?.day_warning;
  telegramMessage.textContent = [
    `${telegramEntries.length} rekod ditemui${date ? ` untuk ${formatDate(date)}` : ''}.`,
    duplicateCount ? `${duplicateCount} rekod pendua tidak dipilih.` : '',
    warning ?? '',
  ].filter(Boolean).join(' ');

  if (warning) telegramMessage.classList.add('preview-warning');
  else telegramMessage.classList.remove('preview-warning');
}

telegramForm.addEventListener('submit', (event) => {
  event.preventDefault();
  try {
    telegramEntries = parseTelegramReliefText(telegramText.value);
    renderTelegramPreview();
  } catch (error) {
    telegramEntries = [];
    telegramPreview.hidden = true;
    importButton.disabled = true;
    telegramMessage.classList.add('preview-warning');
    telegramMessage.textContent = error.message;
  }
});

telegramPreviewBody.addEventListener('change', () => {
  importButton.disabled =
    !telegramPreviewBody.querySelector('input[type="checkbox"]:checked');
});

importButton.addEventListener('click', async () => {
  const selectedIndices = [...telegramPreviewBody.querySelectorAll(
    'input[type="checkbox"]:checked'
  )].map((checkbox) => Number(checkbox.dataset.index));
  const selectedEntries = selectedIndices.map((index) => telegramEntries[index]);
  if (selectedEntries.length === 0) {
    telegramMessage.textContent = 'Pilih sekurang-kurangnya satu rekod untuk disimpan.';
    return;
  }

  importButton.disabled = true;
  const saved = [];
  let syncedCount = 0;
  let localOnlyCount = 0;
  const failures = [];
  for (const entry of selectedEntries) {
    const absence = {
      id: crypto.randomUUID(),
      teacher: entry.teacher_name,
      date: entry.absence_date,
      category: entry.category,
      remark: entry.remark,
      is_partial_day: entry.is_partial_day,
      available_from: entry.available_from,
      available_to: entry.available_to,
    };

    try {
      if (currentSession) {
        await syncAbsence(absence);
        syncedCount += 1;
      } else {
        localOnlyCount += 1;
      }
      absences.push(absence);
      saved.push(absence);
    } catch (error) {
      console.error(`Gagal menyimpan rekod Telegram untuk ${entry.teacher_name}.`, error);
      absences.push(absence);
      saved.push(absence);
      localOnlyCount += 1;
      failures.push(`${entry.teacher_name}: ${error.message}`);
    }
  }

  if (saved.length > 0) {
    saveAbsences();
    render();
    telegramText.value = '';
    telegramEntries = [];
    telegramPreview.hidden = true;
  }

  const savedSummary = currentSession
    ? `${syncedCount} rekod disegerakkan ke Supabase${localOnlyCount ? `; ${localOnlyCount} hanya disimpan pada peranti` : ''}.`
    : `${localOnlyCount} rekod disimpan ke peranti ini sahaja.`;
  telegramMessage.classList.toggle('preview-warning', failures.length > 0);
  telegramMessage.textContent = [
    savedSummary,
    failures.length ? `${failures.length} gagal: ${failures.join('; ')}` : '',
  ].filter(Boolean).join(' ');
  importButton.disabled = true;
  message.textContent = failures.length
    ? 'Sebahagian import Telegram gagal. Semak mesej import.'
    : `Import Telegram selesai: ${saved.length} rekod disimpan.`;
});

authOpenButton.addEventListener('click', () => {
  if (!authDialog.open) authDialog.showModal();
});

document.querySelector('#auth-close-button').addEventListener('click', () => {
  authDialog.close();
});

function formatDate(isoDate) {
  const [year, month, day] = isoDate.split('-').map(Number);
  return new Intl.DateTimeFormat('ms-MY', {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  }).format(new Date(Date.UTC(year, month - 1, day)));
}

function render() {
  const today = localDateString();
  const todaysCount = countDashboardAbsences(absences, today);
  const teachersNeedingRelief = countTeachersNeedingRelief(absences, today);
  document.querySelector('#today-label').textContent = new Intl.DateTimeFormat('ms-MY', {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  }).format(new Date());
  document.querySelector('#absence-count').textContent = String(todaysCount);
  document.querySelector('#relief-needed-count').textContent = String(teachersNeedingRelief);
  document.querySelector('#saved-count').textContent = String(absences.length);

  list.replaceChildren();
  emptyState.hidden = absences.length > 0;

  for (const absence of [...absences].sort((a, b) => b.date.localeCompare(a.date))) {
    const item = document.createElement('li');
    item.className = 'absence-item';

    const details = document.createElement('div');
    const name = document.createElement('p');
    name.className = 'absence-name';
    name.textContent = absence.teacher;

    const date = document.createElement('p');
    date.className = 'absence-detail';
    date.textContent = formatDate(absence.date);
    details.append(name, date);

    if (absence.remark) {
      const remark = document.createElement('p');
      remark.className = 'absence-detail';
      remark.textContent = absence.remark;
      details.append(remark);
    }

    const category = document.createElement('span');
    category.className = 'category-tag';
    category.textContent = absence.category;
    details.append(category);

    const remove = document.createElement('button');
    remove.className = 'delete-record';
    remove.type = 'button';
    remove.textContent = '×';
    remove.setAttribute('aria-label', `Padam rekod ${absence.teacher}`);
    remove.addEventListener('click', async () => {
      try {
        if (absence.remote_id && currentSession) {
          const { error } = await supabaseClient
            .from('daily_absences')
            .delete()
            .eq('id', absence.remote_id);
          if (error) throw error;
        }
        absences = absences.filter((record) => record.id !== absence.id);
        saveAbsences();
        render();
        message.textContent = currentSession
          ? 'Rekod telah dipadam.'
          : 'Rekod telah dipadam daripada peranti ini.';
      } catch (error) {
        console.error('Gagal memadam rekod ketidakhadiran.', error);
        message.textContent = `Rekod tidak dapat dipadam dari Supabase: ${error.message}`;
      }
    });

    item.append(details, remove);
    list.append(item);
  }
}

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  const values = new FormData(form);
  const teacher = String(values.get('teacher') ?? '').trim();
  if (!teacher) return;

  const absence = {
    id: crypto.randomUUID(),
    teacher,
    date: String(values.get('date')),
    category: String(values.get('category')),
    remark: String(values.get('remark') ?? '').trim(),
  };
  absences.push(absence);
  saveAbsences();
  form.elements.teacher.value = '';
  form.elements.remark.value = '';
  dateInput.value = localDateString();
  render();
  if (currentSession) {
    try {
      await syncAbsence(absence);
      render();
      message.textContent = 'Rekod berjaya disimpan ke Supabase.';
    } catch (error) {
      console.error('Gagal menyimpan rekod ke Supabase.', error);
      message.textContent = `Rekod hanya disimpan pada peranti; Supabase gagal: ${error.message}`;
    }
  } else {
    message.textContent = 'Rekod disimpan pada peranti ini sahaja.';
  }
});

document.querySelector('#clear-button').addEventListener('click', () => {
  if (absences.length === 0) {
    message.textContent = 'Tiada rekod untuk dikosongkan.';
    return;
  }

  if (!window.confirm('Padam semua rekod yang disimpan pada peranti ini?')) return;
  if (currentSession && absences.some((record) => record.remote_id)) {
    message.textContent = 'Padam rekod Supabase satu demi satu menggunakan butang ×.';
    return;
  }
  absences = [];
  saveAbsences();
  render();
});

authForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  const values = new FormData(authForm);
  const email = String(values.get('email') ?? '').trim();
  const password = String(values.get('password') ?? '');

  try {
    const { error } = await supabaseClient.auth.signInWithPassword({ email, password });
    if (error) throw error;
    authForm.reset();
  } catch (error) {
    console.error('Log masuk Supabase gagal.', error);
    message.textContent = `Log masuk gagal: ${error.message}`;
  }
});

document.querySelector('#sign-out-button').addEventListener('click', async () => {
  try {
    const { error } = await supabaseClient.auth.signOut();
    if (error) throw error;
    showLocalMode();
    message.textContent = 'Anda telah log keluar. Rekod jauh masih kekal di Supabase.';
  } catch (error) {
    console.error('Log keluar Supabase gagal.', error);
    message.textContent = `Log keluar gagal: ${error.message}`;
  }
});

function renderReliefSuggestions() {
  reliefResults.replaceChildren();
  reliefPrintResults.replaceChildren();

  for (const suggestion of reliefSuggestions) {
    const printRow = document.createElement('tr');
    printRow.dataset.absenceId = suggestion.absence_id;
    printRow.dataset.periodSlot = suggestion.period_slot;
    const reason = [suggestion.absence_category, suggestion.absence_remark]
      .filter(Boolean)
      .join(' · ');
    const printValues = [
      suggestion.original_teacher,
      reason,
      suggestion.period_slot,
      suggestion.subject_name,
      suggestion.class_name,
      suggestion.relief_teacher || 'Tiada guru ganti',
      suggestion.room_name,
    ];
    for (const value of printValues) {
      const cell = document.createElement('td');
      cell.textContent = value;
      printRow.append(cell);
    }
    reliefPrintResults.append(printRow);

    const row = document.createElement('tr');
    row.dataset.absenceId = suggestion.absence_id;
    row.dataset.periodSlot = suggestion.period_slot;

    const selectCell = document.createElement('td');
    selectCell.className = 'relief-select-column';
    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.className = 'relief-row-select';
    checkbox.checked = Boolean(suggestion.relief_teacher_id);
    checkbox.disabled = !suggestion.relief_teacher_id || Boolean(suggestion.saved);
    checkbox.setAttribute(
      'aria-label',
      `Pilih relief ${suggestion.original_teacher}, kelas ${suggestion.class_name}, period ${suggestion.period_slot}`
    );
    selectCell.append(checkbox);

    const originalTeacherCell = document.createElement('td');
    originalTeacherCell.textContent = suggestion.original_teacher;

    const classCell = document.createElement('td');
    classCell.textContent = `${suggestion.class_name} · ${suggestion.period_slot}`;

    const subjectCell = document.createElement('td');
    subjectCell.textContent = suggestion.subject_name;

    const candidateCell = document.createElement('td');
    if (suggestion.candidates.length === 0) {
      if (suggestion.relief_teacher_id) {
        const printCandidate = document.createElement('span');
        printCandidate.className = 'print-candidate';
        printCandidate.textContent = suggestion.relief_teacher;
        candidateCell.append(printCandidate);
        candidateCell.append(document.createTextNode(suggestion.relief_teacher));
      } else {
        candidateCell.textContent = 'Tiada calon lapang';
      }
    } else {
      const select = document.createElement('select');
      select.className = 'relief-choice';
      select.setAttribute(
        'aria-label',
        `Pilih calon relief untuk kelas ${suggestion.class_name}, period ${suggestion.period_slot}`
      );

      for (const candidate of suggestion.candidates) {
        const option = document.createElement('option');
        option.value = candidate.teacher_id;
        option.textContent = `${candidate.full_name} · skor ${candidate.total_score} · ${candidate.relief_count} relief`;
        option.selected = candidate.teacher_id === suggestion.relief_teacher_id;
        select.append(option);
      }

      const printCandidate = document.createElement('span');
      printCandidate.className = 'print-candidate';
      printCandidate.textContent = suggestion.relief_teacher;
      candidateCell.append(select, printCandidate);

      select.addEventListener('change', () => {
        const candidate = suggestion.candidates.find(
          (item) => item.teacher_id === select.value
        );
        if (!candidate) return;
        suggestion.relief_teacher_id = candidate.teacher_id;
        suggestion.relief_teacher = candidate.full_name;
        suggestion.score = candidate.total_score;
        printCandidate.textContent = candidate.full_name;
        const printRow = [...reliefPrintResults.rows].find(
          (candidateRow) =>
            candidateRow.dataset.absenceId === suggestion.absence_id &&
            candidateRow.dataset.periodSlot === suggestion.period_slot
        );
        if (printRow) printRow.cells[5].textContent = candidate.full_name;
        scoreCell.textContent = String(candidate.total_score);
        refreshReliefOptionAvailability();
      });
    }

    const scoreCell = document.createElement('td');
    scoreCell.textContent = suggestion.score === null ? '—' : String(suggestion.score);

    const roomCell = document.createElement('td');
    const roomInput = document.createElement('input');
    roomInput.type = 'text';
    roomInput.maxLength = 120;
    roomInput.className = 'relief-room-input';
    roomInput.value = suggestion.room_name;
    roomInput.placeholder = 'Contoh: Makmal Komputer';
    roomInput.setAttribute(
      'aria-label',
      `Bilik untuk kelas ${suggestion.class_name}, period ${suggestion.period_slot}`
    );
    roomInput.disabled = !currentSession;

    const saveRoomButton = document.createElement('button');
    saveRoomButton.type = 'button';
    saveRoomButton.className = 'button button-outline save-room-button';
    saveRoomButton.textContent = 'Simpan bilik';
    saveRoomButton.disabled = !currentSession;
    roomInput.addEventListener('input', () => {
      saveRoomButton.disabled =
        !currentSession || roomInput.value.trim() === suggestion.room_name;
    });
    saveRoomButton.addEventListener('click', async () => {
      if (!currentSession) {
        reliefMessage.textContent = 'Log masuk untuk menyimpan bilik ke jadual waktu.';
        return;
      }
      if (!suggestion.timetable_id) {
        reliefMessage.textContent = 'ID slot jadual tiada. Jana semula cadangan sebelum menyimpan bilik.';
        return;
      }

      saveRoomButton.disabled = true;
      const roomName = roomInput.value.trim();
      try {
        const { data, error } = await supabaseClient
          .from('master_timetable')
          .update({ room_name: roomName || null })
          .eq('id', suggestion.timetable_id)
          .select('id')
          .maybeSingle();
        if (error) throw error;
        if (!data) throw new Error('Slot jadual tidak ditemui atau tidak dibenarkan dikemas kini.');

        suggestion.room_name = roomName;
        const printRow = [...reliefPrintResults.rows].find(
          (candidateRow) =>
            candidateRow.dataset.absenceId === suggestion.absence_id &&
            candidateRow.dataset.periodSlot === suggestion.period_slot
        );
        if (printRow) printRow.cells[6].textContent = roomName;
        reliefMessage.textContent = roomName
          ? `Bilik ${roomName} berjaya disimpan untuk ${suggestion.class_name}, period ${suggestion.period_slot}.`
          : `Bilik dipadam untuk ${suggestion.class_name}, period ${suggestion.period_slot}.`;
      } catch (error) {
        console.error('Gagal menyimpan bilik jadual.', error);
        reliefMessage.textContent = `Bilik gagal disimpan: ${error.message}`;
        saveRoomButton.disabled = false;
      }
    });
    roomCell.append(roomInput, saveRoomButton);

    if (suggestion.saved) {
      checkbox.checked = false;
      const savedTag = document.createElement('span');
      savedTag.className = 'saved-tag';
      savedTag.textContent = 'Disimpan';
      selectCell.append(savedTag);
    }

    row.append(
      selectCell,
      originalTeacherCell,
      classCell,
      subjectCell,
      candidateCell,
      roomCell,
      scoreCell
    );
    reliefResults.append(row);
  }

  const hasCandidates = reliefSuggestions.some((suggestion) =>
    suggestion.candidates.length > 0 && !suggestion.saved
  );
  const date = reliefSuggestions[0]?.absence_date ?? reliefDateInput.value;
  document.querySelector('#relief-print-heading').textContent =
    `Cadangan Relief · ${formatDate(date)}`;
  saveReliefButton.disabled = !currentSession || !hasCandidates;
  exportPdfButton.disabled = reliefSuggestions.length === 0;
  refreshReliefOptionAvailability();
}

function refreshReliefOptionAvailability() {
  for (const suggestion of reliefSuggestions) {
    const row = [...reliefResults.rows].find(
      (candidateRow) =>
        candidateRow.dataset.absenceId === suggestion.absence_id &&
        candidateRow.dataset.periodSlot === suggestion.period_slot
    );
    const select = row?.querySelector('.relief-choice');
    if (!select) continue;

    for (const option of select.options) {
      const assignedToOtherSlot = reliefSuggestions.some(
        (other) =>
          other !== suggestion &&
          other.period_slot === suggestion.period_slot &&
          other.relief_teacher_id === option.value
      );
      option.disabled = assignedToOtherSlot;
    }
  }
}

function updateReliefSelection() {
  saveReliefButton.disabled =
    !currentSession ||
    !reliefResults.querySelector('.relief-row-select:checked');
}

reliefResults.addEventListener('change', (event) => {
  if (event.target.matches('.relief-row-select')) updateReliefSelection();
});

reliefForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  if (!currentSession) {
    reliefMessage.textContent = 'Log masuk melalui butang di bahagian atas untuk menjana cadangan sekolah.';
    return;
  }

  const date = reliefDateInput.value;
  const generateButton = document.querySelector('#generate-relief-button');
  generateButton.disabled = true;
  saveReliefButton.disabled = true;
  exportPdfButton.disabled = true;
  reliefMessage.textContent = 'Sedang menyemak ketidakhadiran, jadual waktu dan beban relief...';

  try {
    const result = await generateReliefSuggestions(supabaseClient, date);
    reliefSuggestions = result.slots.map((slot) => {
      const candidates = slot.candidates.map((candidate) => ({
        teacher_id: candidate.teacher_id,
        full_name: candidate.teacher_name,
        option_subject: null,
        relief_count: Number(candidate.relief_load),
        fairness_score: candidate.score,
        subject_match: candidate.subject_match,
        subject_bonus: candidate.subject_match ? 20 : 0,
        total_score: candidate.score,
      }));
      const bestCandidate = candidates[0];
      return {
        timetable_id: slot.timetable_id,
        absence_id: slot.absence_id,
        absence_date: date,
        original_teacher_id: slot.original_teacher_id,
        original_teacher: slot.original_teacher_name,
        absence_category: slot.absence_category,
        absence_remark: slot.absence_remark,
        period_slot: slot.period_slot,
        class_name: slot.class_name,
        subject_name: slot.subject_name,
        room_name: slot.room_name,
        candidates,
        relief_teacher_id: bestCandidate?.teacher_id ?? '',
        relief_teacher: bestCandidate?.full_name ?? '',
        score: bestCandidate?.total_score ?? null,
      };
    });
    renderReliefSuggestions();
    reliefWarnings.replaceChildren();
    reliefWarnings.hidden = result.warnings.length === 0;
    for (const warning of result.warnings) {
      const item = document.createElement('p');
      item.textContent = warning;
      reliefWarnings.append(item);
    }

    if (reliefSuggestions.length === 0) {
      reliefMessage.textContent = result.warnings[0] ??
        `Tiada rekod ketidakhadiran dengan jadual kelas pada ${formatDate(date)}.`;
    } else {
      const noCandidateCount = reliefSuggestions.filter(
        (suggestion) => !suggestion.relief_teacher_id
      ).length;
      reliefMessage.textContent =
        `${reliefSuggestions.length} slot relief dijana untuk ${formatDate(date)}.` +
        (noCandidateCount ? ` ${noCandidateCount} slot tiada calon lapang.` : '');
    }
  } catch (error) {
    console.error('Gagal menjana cadangan guru ganti.', error);
    reliefSuggestions = [];
    renderReliefSuggestions();
    reliefMessage.textContent = `Gagal menjana cadangan: ${error.message}`;
  } finally {
    generateButton.disabled = false;
  }
});

saveReliefButton.addEventListener('click', async () => {
  const selected = new Set(
    [...reliefResults.querySelectorAll('.relief-row-select:checked')].map((checkbox) => {
      const row = checkbox.closest('tr');
      return `${row.dataset.absenceId}|${row.dataset.periodSlot}`;
    })
  );
  const rowsToSave = reliefSuggestions.filter(
    (suggestion) =>
      selected.has(`${suggestion.absence_id}|${suggestion.period_slot}`) &&
      suggestion.relief_teacher_id &&
      !suggestion.saved
  );
  if (rowsToSave.length === 0) return;

  saveReliefButton.disabled = true;
  const failures = [];
  let savedCount = 0;
  for (const suggestion of rowsToSave) {
    try {
      const { error } = await supabaseClient.from('relief_assignments').insert({
        absence_id: suggestion.absence_id,
        period_slot: suggestion.period_slot,
        class_name: suggestion.class_name,
        original_teacher_id: suggestion.original_teacher_id,
        relief_teacher_id: suggestion.relief_teacher_id,
        status: 'suggested',
      });

      if (error) throw error;
      suggestion.saved = true;
      savedCount += 1;
    } catch (error) {
      console.error('Gagal menyimpan tugasan relief.', error);
      failures.push(
        `${suggestion.class_name} period ${suggestion.period_slot}: ${error.message}`
      );
    }
  }

  renderReliefSuggestions();
  reliefMessage.textContent = [
    `${savedCount} tugasan cadangan disimpan ke Supabase.`,
    failures.length ? `${failures.length} gagal: ${failures.join('; ')}` : '',
  ].filter(Boolean).join(' ');
});

exportPdfButton.addEventListener('click', () => {
  if (reliefSuggestions.length === 0) return;
  switchTab('relief');
  document.body.classList.add('printing-relief');
  window.addEventListener('afterprint', () => {
    document.body.classList.remove('printing-relief');
  }, { once: true });
  window.print();
});

function switchTab(tabName) {
  for (const button of tabButtons) {
    button.setAttribute('aria-selected', String(button.dataset.tab === tabName));
  }
  for (const panel of tabPanels) {
    panel.hidden = panel.dataset.tabPanel !== tabName;
  }
}

tabButtons.forEach((button) => {
  button.addEventListener('click', () => switchTab(button.dataset.tab));
});

function updateConnectionStatus() {
  const isOnline = navigator.onLine;
  connectionStatus.classList.toggle('offline', !isOnline);
  connectionStatus.lastElementChild.textContent = isOnline ? 'Dalam talian' : 'Luar talian';
}

window.addEventListener('online', updateConnectionStatus);
window.addEventListener('offline', updateConnectionStatus);

window.addEventListener('beforeinstallprompt', (event) => {
  event.preventDefault();
  installPrompt = event;
  installButton.hidden = false;
});

installButton.addEventListener('click', async () => {
  if (!installPrompt) return;
  await installPrompt.prompt();
  installPrompt = null;
  installButton.hidden = true;
});

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch((error) => {
      console.error('Pendaftaran service worker gagal.', error);
      message.textContent = 'Mod luar talian tidak dapat diaktifkan.';
    });
  });
}

dateInput.value = localDateString();
reliefDateInput.value = localDateString();
updateConnectionStatus();
render();
renderReliefSuggestions();
configureSupabase();
