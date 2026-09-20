import assert from 'node:assert/strict';
import test from 'node:test';
import {
  addBuiltInSetMetadata,
  parseSamuraiSwordSets,
} from '../src/set-cache.ts';

test('keeps mc metadata when the public set table does not include it', () => {
  const sets = addBuiltInSetMetadata(new Map());

  assert.deepEqual(sets.get('mc'), {
    englishName: 'MEGA Start Deck 100 Battle Collection',
    japaneseName: 'スタートデッキ100 バトルコレクション',
    mainSetTotal: 742,
  });
});

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

test('uses card-list links for split and duplicate visible set labels', () => {
  const sets = parseSamuraiSwordSets([
    {
      cells: [
        'SV4',
        '古代の咆哮/未来の一閃',
        'Ancient Roar / Future Flash',
        '2023-10-27',
        'EXP',
        '¥180',
        '66',
      ],
      links: [
        {
          href: 'https://samuraiswordtokyo.com/pages/sv4k-card-list',
          text: 'Ancient Roar',
          cellIndex: 2,
        },
        {
          href: 'https://samuraiswordtokyo.com/pages/sv4m-card-list',
          text: 'Future Flash',
          cellIndex: 2,
        },
      ],
    },
    {
      cells: [
        'SV11',
        'ブラックボルト',
        'Black Bolt',
        '2025-06-06',
        'EXP',
        '¥290',
        '86',
      ],
      links: [
        {
          href: 'https://samuraiswordtokyo.com/pages/sv11b-card-list',
          text: 'SV11',
          cellIndex: 0,
        },
      ],
    },
  ]);

  assert.deepEqual(sets.get('sv4k'), {
    englishName: 'Ancient Roar',
    japaneseName: '古代の咆哮',
    mainSetTotal: 66,
  });
  assert.deepEqual(sets.get('sv4m'), {
    englishName: 'Future Flash',
    japaneseName: '未来の一閃',
    mainSetTotal: 66,
  });
  assert.deepEqual(sets.get('sv11b'), {
    englishName: 'Black Bolt',
    japaneseName: 'ブラックボルト',
    mainSetTotal: 86,
  });
  assert.equal(sets.has('sv4'), false);
  assert.equal(sets.has('sv11'), false);
});
