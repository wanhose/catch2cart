/**
 * Card identity and local name conversion helpers.
 *
 * These functions contain no browser or network access. They form the
 * deterministic boundary between Cardmarket's English names and the Japanese
 * search terms used by Japanese product providers.
 */

import { createRequire } from 'node:module';
import { DORASUTA_URL } from './config.ts';
import { outputLog } from './output.ts';

const require = createRequire(import.meta.url);
const pokemonData = require('@motemen/pokemon-data');

const SPECIAL_SEARCH_NAMES = new Map([['Perrin', 'サザレ']]);

/**
 * Build a local English -> Japanese species map.
 *
 * Multiple form rows may exist for the same species, so only the first
 * valid species-name pair is retained.
 */
const EN_TO_JA = new Map();

for (const row of pokemonData) {
  const english = row.pokeapi_species_name_en;

  const japanese = row.pokeapi_species_name_ja;

  if (english && japanese && !EN_TO_JA.has(english)) {
    EN_TO_JA.set(english, japanese);
  }
}

/**
 * Longest names first to reduce accidental substring matches.
 */
const ENGLISH_POKEMON_NAMES = [...EN_TO_JA.keys()].sort(
  (a, b) => b.length - a.length,
);

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Collapse scraped whitespace and make nullable text safe to compare. */
function normalizeWhitespace(value) {
  return String(value ?? '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Extract Dorasuta's `pid` from an absolute or relative product URL. */
function getDorasutaProductId(value) {
  try {
    return new URL(value, DORASUTA_URL).searchParams.get('pid');
  } catch {
    return null;
  }
}

/** Convert a collector number to a canonical decimal string. */
function normalizeNumber(value) {
  const number = Number(value);

  if (!Number.isFinite(number)) {
    return null;
  }

  return String(number);
}

/** Compare collector numbers while tolerating numeric string formatting. */
function numbersEqual(a, b) {
  const normalizedA = normalizeNumber(a);

  const normalizedB = normalizeNumber(b);

  return (
    normalizedA !== null && normalizedB !== null && normalizedA === normalizedB
  );
}

/**
 * Abort before touching Cardmarket or a product provider if the local dataset
 * is not behaving as expected.
 */
function validatePokemonDataset() {
  const checks = [
    ['Pikachu', 'ピカチュウ'],
    ['Meowth', 'ニャース'],
    ['Articuno', 'フリーザー'],
    ['Gengar', 'ゲンガー'],
    ['Greninja', 'ゲッコウガ'],
    ['Gholdengo', 'サーフゴー'],
  ];

  for (const [english, expectedJapanese] of checks) {
    const japanese = EN_TO_JA.get(english);

    if (japanese !== expectedJapanese) {
      throw new Error(
        `Local Pokémon dataset mismatch: ` +
          `${english} -> ${japanese ?? 'undefined'}, ` +
          `expected ${expectedJapanese}.`,
      );
    }
  }

  outputLog(
    `Local Pokémon EN -> JA dataset check: OK ` + `(${EN_TO_JA.size} species)`,
  );
}

/**
 * Cardmarket:
 *
 *   Ariados (s8b 205)
 *   Pikachu ex (m6a 126)
 *   Detective Pikachu (SV-P 098)
 *   Mega Venusaur ex (m1L 087)
 */
function parseCardmarketName(value) {
  const normalized = normalizeWhitespace(value);

  const match = normalized.match(/^(.+?)\s*\(\s*([A-Za-z0-9-]+)\s+(\d+)\s*\)$/);

  if (!match) {
    return null;
  }

  return {
    name: match[1].trim(),

    set: match[2].toLowerCase(),

    number: match[3],
  };
}

/**
 * Examples:
 *
 *   Team Rocket's Mewtwo ex
 *   -> Mewtwo
 *
 *   Cynthia's Garchomp ex
 *   -> Garchomp
 *
 *   Mega Greninja ex
 *   -> Greninja
 *
 *   Bloodmoon Ursaluna ex
 *   -> Ursaluna
 *
 *   Castform Sunny Form
 *   -> Castform
 *
 *   Fan Rotom
 *   -> Rotom
 */
function extractPokemonSpecies(cardName) {
  const normalized = cardName.toLowerCase();

  for (const species of ENGLISH_POKEMON_NAMES) {
    const escaped = escapeRegExp(species.toLowerCase());

    const regex = new RegExp(`(^|[^a-z])${escaped}(?=[^a-z]|$)`, 'i');

    if (regex.test(normalized)) {
      return species;
    }
  }

  return null;
}

function extractTcgSuffix(cardName) {
  const suffixes = [
    {
      regex: /\s+V-UNION$/i,
      value: 'V-UNION',
    },
    {
      regex: /\s+VMAX$/i,
      value: 'VMAX',
    },
    {
      regex: /\s+VSTAR$/i,
      value: 'VSTAR',
    },
    {
      regex: /\s+GX$/,
      value: 'GX',
    },
    {
      regex: /\s+EX$/,
      value: 'EX',
    },
    {
      regex: /\s+ex$/,
      value: 'ex',
    },
    {
      regex: /\s+V$/,
      value: 'V',
    },
  ];

  for (const suffix of suffixes) {
    if (suffix.regex.test(cardName)) {
      return suffix.value;
    }
  }

  return '';
}

/** Look up a Japanese species name in the bundled local dataset. */
function getJapanesePokemonName(englishSpecies) {
  return EN_TO_JA.get(englishSpecies) ?? null;
}

/**
 * We intentionally search broadly.
 *
 * Team Rocket's Mewtwo ex
 * -> ミュウツーex
 *
 * Galarian Articuno V
 * -> フリーザーV
 *
 * Mega Greninja ex
 * -> ゲッコウガex
 *
 * Final identity is always checked by:
 *
 *   set + collector number
 */
function buildJapaneseSearchName(cardmarketName) {
  if (SPECIAL_SEARCH_NAMES.has(cardmarketName)) {
    return {
      species: null,
      japaneseSpecies: null,
      suffix: '',
      searchName: SPECIAL_SEARCH_NAMES.get(cardmarketName),
      strategy: 'special-local-name',
    };
  }

  const species = extractPokemonSpecies(cardmarketName);

  if (!species) {
    return {
      searchName: null,
      strategy: 'pokemon-species-not-found',
    };
  }

  const japaneseSpecies = getJapanesePokemonName(species);

  if (!japaneseSpecies) {
    return {
      searchName: null,
      species,
      strategy: 'japanese-name-not-found',
    };
  }

  const suffix = extractTcgSuffix(cardmarketName);

  return {
    species,
    japaneseSpecies,
    suffix,

    searchName: `${japaneseSpecies}${suffix}`,

    strategy: 'local-species-and-tcg-suffix',
  };
}

/**
 * Dorasuta examples:
 *
 *   ピカチュウex(126/103)
 *   -> 126
 *
 *   ピカチュウex(SAR仕様)(764/742)
 *   -> 764
 *
 *   ピカチュウex(132/M-P)
 *   -> 132
 */
function parseCollectorNumber(text) {
  const matches = [...String(text ?? '').matchAll(/\((\d+)\/[^)]+\)/g)];

  if (!matches.length) {
    return null;
  }

  return matches.at(-1)[1];
}

/** V-UNION products are sold as four-card bundles by the supported shops. */
function isVUnionCardTitle(title) {
  return /\bv[\s-]*union\b/i.test(String(title ?? ''));
}

export {
  buildJapaneseSearchName,
  extractPokemonSpecies,
  extractTcgSuffix,
  getDorasutaProductId,
  isVUnionCardTitle,
  normalizeNumber,
  normalizeWhitespace,
  numbersEqual,
  parseCardmarketName,
  parseCollectorNumber,
  validatePokemonDataset,
};
