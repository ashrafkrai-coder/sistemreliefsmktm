import test from 'node:test';
import assert from 'node:assert/strict';
import {
  countDashboardAbsences,
  countTeachersNeedingRelief,
} from '../dashboard-summary.js';

test('counts only today MC, CRK, and other-leave records', () => {
  const absences = [
    { date: '2026-09-29', category: 'CUTI SAKIT (MC)' },
    { date: '2026-09-29', category: 'CRK' },
    { date: '2026-09-29', category: 'LAIN-LAIN CUTI' },
    { date: '2026-09-29', category: 'TUGASAN LUAR' },
    { date: '2026-09-28', category: 'CRK' },
  ];

  assert.equal(countDashboardAbsences(absences, '2026-09-29'), 3);
});

test('accepts MC abbreviation and ignores category casing and punctuation', () => {
  const absences = [
    { date: '2026-09-29', category: 'mc' },
    { date: '2026-09-29', category: 'lain lain cuti' },
  ];

  assert.equal(countDashboardAbsences(absences, '2026-09-29'), 2);
});

test('counts unique teachers needing relief today across every category', () => {
  const absences = [
    { teacher: 'Guru Satu', date: '2026-09-29', category: 'CUTI SAKIT (MC)' },
    { teacher: 'Guru Dua', date: '2026-09-29', category: 'CRK' },
    { teacher: 'Guru Tiga', date: '2026-09-29', category: 'TUGASAN LUAR' },
    { teacher: 'Guru Empat', date: '2026-09-29', category: 'LAIN-LAIN URUSAN' },
    { teacher: 'guru satu', date: '2026-09-29', category: 'LAIN-LAIN CUTI' },
    { teacher: 'Guru Lima', date: '2026-09-28', category: 'CRK' },
  ];

  assert.equal(countTeachersNeedingRelief(absences, '2026-09-29'), 4);
});
