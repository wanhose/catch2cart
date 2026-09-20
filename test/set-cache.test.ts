import assert from 'node:assert/strict';
import test from 'node:test';
import { parseSamuraiSwordSets } from '../src/set-cache.ts';

test('stores Samurai Sword Tokyo fields in their explicit structured columns', () => {
  const sets = parseSamuraiSwordSets([
    {
      cells: [
        'SV2D',
        'クレイバースト',
        'Clay Burst',
        '2023-04-14',
        'EXP',
        '¥180',
        '71',
      ],
    },
  ]);
  assert.deepEqual(sets.get('sv2d'), {
    englishName: 'Clay Burst',
    japaneseName: 'クレイバースト',
    mainSetTotal: 71,
  });
});

test('extracts the main-set total before compiled secret cards', () => {
  const sets = parseSamuraiSwordSets([
    {
      cells: [
        'M6a',
        '30th CELEBRATION',
        '30th Celebration',
        '2026-09-16',
        'ENH',
        '¥360',
        '103 (+32 secrets, compiled)',
      ],
    },
  ]);
  assert.deepEqual(sets.get('m6a'), {
    englishName: '30th Celebration',
    japaneseName: '30th CELEBRATION',
    mainSetTotal: 103,
  });
});

test('parses the compact public metadata row format', () => {
  const sets = parseSamuraiSwordSets([
    {
      cells: [
        'SM11b',
        'ドリームリーグ (Dream League)',
        '2019-08-02',
        'ENH',
        '49',
        'part of Cosmic Eclipse',
      ],
    },
  ]);
  assert.deepEqual(sets.get('sm11b'), {
    englishName: 'Dream League',
    japaneseName: 'ドリームリーグ',
    mainSetTotal: 49,
  });
});
