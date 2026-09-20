import { readFile, writeFile } from 'node:fs/promises';
import type { Page } from 'playwright';
import {
  CLEAR_PRODUCT_CACHE,
  NAVIGATION_TIMEOUT_MS,
  PRODUCT_CACHE_TTL_HOURS,
  SAMURAI_SWORD_SET_LIST_URL,
  SET_CACHE_FILE,
} from './config.ts';
import { gotoAndWait } from './browser.ts';
import { normalizeWhitespace } from './cards.ts';
import { outputLog } from './output.ts';

export interface PokemonSetMetadata {
  englishName: string;
  japaneseName: string;
  mainSetTotal: number;
}

let setsByCode = new Map<string, PokemonSetMetadata>();

/** Parse Samurai Sword Tokyo table columns without mixing language fields. */
export function parseSamuraiSwordSets(rows: { cells: string[] }[]) {
  const sets = new Map<string, PokemonSetMetadata>();
  for (const { cells } of rows) {
    const code = normalizeWhitespace(cells[0] ?? '')
      .match(/^([a-z]+\d+[a-z]*)/i)?.[1]
      ?.toLowerCase();
    const hasExplicitLanguageColumns = cells.length >= 7;
    const explicitEnglishName = hasExplicitLanguageColumns
      ? normalizeWhitespace(cells[2] ?? '')
      : '';
    const combinedName = normalizeWhitespace(cells[1] ?? '');
    const combinedNameMatch = combinedName.match(/^(.+?)\s*\(([^()]+)\)$/);
    const japaneseName = explicitEnglishName
      ? combinedName
      : normalizeWhitespace(combinedNameMatch?.[1] ?? '');
    const englishName =
      explicitEnglishName || normalizeWhitespace(combinedNameMatch?.[2] ?? '');
    const totalCell = hasExplicitLanguageColumns ? cells[6] : cells[4];
    const total = Number(
      normalizeWhitespace(totalCell ?? '').match(/^\d+/)?.[0],
    );
    if (
      !code ||
      !japaneseName ||
      !englishName ||
      !Number.isInteger(total) ||
      total <= 0
    )
      continue;
    sets.set(code, {
      englishName,
      japaneseName,
      mainSetTotal: total,
    });
  }
  return sets;
}

export function getPokemonSet(setCode: string) {
  return setsByCode.get(setCode.toLowerCase()) ?? null;
}

/** Compatibility helper for the ManaSource collection-name verifier. */
export function getDorasutaSetNames(setCode: string) {
  const set = getPokemonSet(setCode);
  return set ? [set.japaneseName] : null;
}

export function getPokemonSetTotal(setCode: string) {
  return getPokemonSet(setCode)?.mainSetTotal ?? null;
}

function isFresh(updatedAt: unknown) {
  const timestamp = typeof updatedAt === 'string' ? Date.parse(updatedAt) : NaN;
  return (
    Number.isFinite(timestamp) &&
    (PRODUCT_CACHE_TTL_HOURS === 0 ||
      Date.now() - timestamp <= PRODUCT_CACHE_TTL_HOURS * 3_600_000)
  );
}

function isSetMetadata(value: unknown): value is PokemonSetMetadata {
  if (!value || typeof value !== 'object') return false;
  const set = value as PokemonSetMetadata;
  return (
    typeof set.englishName === 'string' &&
    typeof set.japaneseName === 'string' &&
    Number.isInteger(set.mainSetTotal) &&
    set.mainSetTotal > 0
  );
}

export async function loadSetCache() {
  try {
    const cached = JSON.parse(await readFile(SET_CACHE_FILE, 'utf8'));
    if (
      CLEAR_PRODUCT_CACHE ||
      !cached?.sets ||
      typeof cached.sets !== 'object' ||
      !isFresh(cached.updatedAt)
    )
      return false;
    const entries = Object.entries(cached.sets);
    if (entries.some(([, value]) => !isSetMetadata(value))) return false;
    setsByCode = new Map(
      entries.map(([code, value]) => [
        code.toLowerCase(),
        value as PokemonSetMetadata,
      ]),
    );
    outputLog('Using set cache: ' + setsByCode.size + ' structured set(s)');
    return setsByCode.size > 0;
  } catch {
    return false;
  }
}

export async function refreshSetCache(page: Page) {
  await gotoAndWait(page, SAMURAI_SWORD_SET_LIST_URL, {
    waitUntil: 'domcontentloaded',
    timeout: NAVIGATION_TIMEOUT_MS,
  });
  const rows = await page
    .locator('table.blog-table tbody tr')
    .evaluateAll((elements) =>
      elements.map((row) => ({
        cells: [...row.querySelectorAll('td')].map(
          (cell) => cell.textContent ?? '',
        ),
      })),
    );
  setsByCode = parseSamuraiSwordSets(rows);
  if (!setsByCode.size)
    throw new Error('Set metadata page did not yield any coded sets.');
  await writeFile(
    SET_CACHE_FILE,
    JSON.stringify(
      {
        version: 1,
        updatedAt: new Date().toISOString(),
        sets: Object.fromEntries(setsByCode),
      },
      null,
      2,
    ) + '\n',
    'utf8',
  );
  outputLog('Refreshed set cache: ' + setsByCode.size + ' structured set(s)');
}
