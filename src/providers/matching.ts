import { getPokemonSet, getPokemonSetTotal } from '../set-cache.ts';
import {
  buildJapaneseSearchName,
  normalizeWhitespace,
  numbersEqual,
} from '../cards.ts';

export interface WishlistCardIdentity {
  set: string;
  number: string;
  cardmarketName?: string;
}

/** Build the provider search suffix used by Japanese card listings. */
export function formatProviderNumberTotal(number: string, total: number) {
  const numberText = String(number).padStart(3, '0');
  const totalText = String(total).padStart(3, '0');

  return `${numberText}/${totalText}`;
}

function formatProviderNumber(number: string) {
  return String(number).padStart(3, '0');
}

function isPromoSetCode(setCode: string) {
  return ['sv-p', 's-p'].includes(setCode.toLowerCase());
}

export function buildProviderSearchQueries(
  searchName: string,
  card: WishlistCardIdentity,
) {
  const number = String(card.number);
  const total = getPokemonSetTotal(card.set);
  if (!/^\d+$/.test(number)) return [];

  const formattedNumber = formatProviderNumber(number);
  const unpaddedNumber = number.replace(/^0+/, '') || '0';
  const trailingNumber = new RegExp(
    `(?:\\s+0*${unpaddedNumber})+(?:\\s*/\\s*0*\\d+)?$`,
  );
  const baseName = normalizeWhitespace(searchName).replace(trailingNumber, '');

  if (isPromoSetCode(card.set)) {
    const formattedPromoNumber = `${formattedNumber}/${card.set.toUpperCase()}`;
    return [[baseName, formattedPromoNumber].join(' '), formattedPromoNumber];
  }

  if (!total) {
    return [[baseName, formattedNumber].join(' '), formattedNumber];
  }

  const formattedNumberTotal = formatProviderNumberTotal(number, total);
  return [
    [baseName, formattedNumberTotal].join(' '),
    formattedNumberTotal,
  ].filter(
    (query, index, queries) => query && queries.indexOf(query) === index,
  );
}

export interface ProviderProductIdentity {
  productName?: string | null;
  collectorNumber?: string | null;
  totalNumber?: string | null;
  setCode?: string | null;
  collectionName?: string | null;
}

export interface ProviderCartEntry extends ProviderProductIdentity {
  productId: string;
  url: string | null;
  quantity: number;
}

export function findMatchingCartEntry(
  card: WishlistCardIdentity,
  entries: readonly ProviderCartEntry[],
) {
  const matches = entries.filter(
    (entry) => matchProviderProduct(card, entry).kind !== 'none',
  );

  return matches.length === 1 ? matches[0] : null;
}

export type ProductMatchKind = 'exact' | 'number-total' | 'none';

export interface ProductMatch {
  kind: ProductMatchKind;
  score: number;
}

function parseNumberIdentity(value: string | null | undefined) {
  const match = normalizeWhitespace(value).match(
    /(\d+)\s*\/\s*([A-Za-z][A-Za-z0-9-]*|\d+)/,
  );

  if (!match) return null;

  return {
    number: match[1],
    total: /^\d+$/.test(match[2]) ? match[2] : null,
    setCode: /^\d+$/.test(match[2]) ? null : match[2],
  };
}

/** Normalize provider labels without depending on punctuation or separators. */
function normalizeIdentityText(value: string | null | undefined) {
  return normalizeWhitespace(value)
    .toLocaleLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '');
}

function includesNormalizedIdentity(
  expected: string | null | undefined,
  actual: string | null | undefined,
) {
  const normalizedExpected = normalizeIdentityText(expected);
  const normalizedActual = normalizeIdentityText(actual);

  return Boolean(
    normalizedExpected &&
    normalizedActual &&
    (normalizedExpected.includes(normalizedActual) ||
      normalizedActual.includes(normalizedExpected)),
  );
}

function isStructuredSetCode(value: string) {
  return /^(?:[a-z]+\d+[a-z]*|(?:s|sv)-p)$/i.test(value);
}

/**
 * Evaluate the identity fields exposed by every product provider.
 *
 * A collector number is always required. A provider can then prove the set
 * either with its code/name or with the observed `number/total` pair. A total
 * that contradicts the public set metadata is never accepted.
 */
export function matchProviderProduct(
  card: WishlistCardIdentity,
  product: ProviderProductIdentity,
): ProductMatch {
  const parsedTitle = parseNumberIdentity(product.productName);
  const collectorNumber =
    product.collectorNumber ?? parsedTitle?.number ?? null;
  const totalNumber = product.totalNumber ?? parsedTitle?.total ?? null;
  const productSetCode = parsedTitle?.setCode ?? product.setCode ?? null;

  if (!collectorNumber || !numbersEqual(card.number, collectorNumber)) {
    return { kind: 'none', score: 0 };
  }

  const metadata = getPokemonSet(card.set);
  const expectedTotal = metadata?.mainSetTotal ?? null;

  const setCodeMatches =
    productSetCode !== null &&
    normalizeIdentityText(productSetCode) === normalizeIdentityText(card.set);

  if (isPromoSetCode(card.set)) {
    return setCodeMatches
      ? { kind: 'exact', score: 150 }
      : { kind: 'none', score: 0 };
  }

  if (expectedTotal !== null && totalNumber !== null) {
    if (!numbersEqual(expectedTotal, totalNumber)) {
      return { kind: 'none', score: 0 };
    }
  }

  const collectionNameMatches =
    Boolean(metadata) &&
    includesNormalizedIdentity(metadata?.japaneseName, product.collectionName);
  const japaneseSearchName = card.cardmarketName
    ? buildJapaneseSearchName(card.cardmarketName).searchName
    : null;
  const pokemonNameMatches = includesNormalizedIdentity(
    japaneseSearchName,
    product.productName,
  );
  const totalMatches =
    totalNumber !== null &&
    (expectedTotal === null || numbersEqual(expectedTotal, totalNumber));

  if (
    productSetCode !== null &&
    isStructuredSetCode(productSetCode) &&
    !setCodeMatches
  ) {
    return { kind: 'none', score: 0 };
  }

  if (setCodeMatches || collectionNameMatches || pokemonNameMatches) {
    return {
      kind: 'exact',
      score: 100 + (totalMatches ? 20 : 0),
    };
  }

  if (totalMatches) {
    return { kind: 'number-total', score: 60 };
  }

  return { kind: 'none', score: 0 };
}
