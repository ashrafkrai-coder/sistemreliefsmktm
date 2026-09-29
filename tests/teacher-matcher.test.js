import test from 'node:test';
import assert from 'node:assert/strict';
import { findTeacherByName } from '../teacher-matcher.js';

const teachers = [
  { id: '1', full_name: 'LILY JULIANI BINTI JAAFAR' },
  { id: '2', full_name: 'NURUL AMIRA BT MOHAMAD TAHIR' },
  { id: '3', full_name: 'NOR HABSAH BT SUKAIMI' },
  { id: '4', full_name: 'NORHAYATI BINTI SHAMSHOL BAHAR' },
  { id: '5', full_name: 'NOOR HAWATI BINTI YUSOF' },
];

test('matches concatenated initials to a unique Supabase teacher', () => {
  assert.equal(findTeacherByName('LJ', teachers).id, '1');
});

test('matches dotted and spaced initials to a unique Supabase teacher', () => {
  assert.equal(findTeacherByName('N. H. S.', teachers).id, '3');
});

test('keeps full-name matching ahead of initial matching', () => {
  assert.equal(findTeacherByName('Nurul Amira', teachers).id, '2');
});

test('reports ambiguous initials rather than selecting an arbitrary teacher', () => {
  assert.throws(
    () => findTeacherByName('NH', teachers),
    /sepadan dengan beberapa guru/
  );
});
