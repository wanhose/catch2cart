import assert from 'node:assert/strict';
import test from 'node:test';
import { buildCostReport, formatCostReport } from '../src/report.ts';

test('calculates provider totals, partial stock and the best observed mix', () => {
  const cards = [
    { quantity: 2, cardmarketName: 'Pikachu', set: 'sv', number: '1' },
    { quantity: 1, cardmarketName: 'Eevee', set: 'sv', number: '2' },
  ];
  const entries = new Map([
    [
      'sv:1:pikachu',
      {
        urls: [],
        offers: {
          'pao-onlineshop.com': [
            {
              url: 'pao-1',
              productName: 'Pikachu',
              price: 100,
              stock: 1,
              available: true,
              addable: true,
              status: 'OBSERVED',
              checkedAt: '2026-09-20T12:00:00.000Z',
            },
          ],
          'torecacamp-pokemon.com': [
            {
              url: 'toreca-1',
              productName: 'Pikachu',
              price: 120,
              stock: 2,
              available: true,
              addable: true,
              status: 'OBSERVED',
              checkedAt: '2026-09-20T12:00:00.000Z',
            },
          ],
        },
      },
    ],
    [
      'sv:2:eevee',
      {
        urls: [],
        offers: {
          'pao-onlineshop.com': [
            {
              url: 'pao-2',
              productName: 'Eevee',
              price: 90,
              stock: 0,
              available: false,
              addable: false,
              status: 'OBSERVED',
              checkedAt: '2026-09-20T12:00:00.000Z',
            },
          ],
        },
      },
    ],
  ]);
  const report = buildCostReport(
    cards,
    ['pao', 'toreca'],
    (key) => entries.get(key),
    (card) => `${card.set}:${card.number}:${card.cardmarketName.toLowerCase()}`,
    Date.parse('2026-09-20T11:00:00.000Z'),
  );

  assert.deepEqual(report.providers[0], {
    provider: 'pao',
    cost: 100,
    fullCards: 0,
    partialCards: 1,
    missingQuantity: 1,
    unavailableCards: 1,
    observedCards: 1,
  });
  assert.equal(report.providers[1].cost, 240);
  assert.equal(report.providers[1].fullCards, 1);
  assert.equal(report.idealCost, 240);
  assert.equal(report.idealMissingQuantity, 0);
  assert.match(formatCostReport(report), /Best observed mix/);
});

test('ignores offers observed before the current run', () => {
  const report = buildCostReport(
    [{ quantity: 1, cardmarketName: 'Pikachu', set: 'sv', number: '1' }],
    ['pao'],
    () => ({
      urls: [],
      offers: {
        'pao-onlineshop.com': [
          {
            url: 'pao-1',
            productName: 'Pikachu',
            price: 100,
            stock: 1,
            available: true,
            addable: true,
            status: 'OBSERVED',
            checkedAt: '2026-09-19T12:00:00.000Z',
          },
        ],
      },
    }),
    () => 'ignored',
    Date.parse('2026-09-20T12:00:00.000Z'),
  );

  assert.equal(report.providers[0].observedCards, 0);
  assert.equal(report.providers[0].unavailableCards, 1);
});
