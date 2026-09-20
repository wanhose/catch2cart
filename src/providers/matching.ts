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
export function buildProviderSearchName(
  searchName: string,
  card: WishlistCardIdentity,
) {
  const number = String(card.number);
  const suffix = getPokemonSetTotal(card.set)
    ? `${number}/${getPokemonSetTotal(card.set)}`
    : number;
  const trailingNumber = new RegExp(`(?:\\s+${number})+(?:\\s*/\\s*\\d+)?$`);
  const baseName = normalizeWhitespace(searchName).replace(trailingNumber, '');

  return [baseName, suffix].filter(Boolean).join(' ');
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

function parseNumberAndTotal(value: string | null | undefined) {
  const match = normalizeWhitespace(value).match(/(\d+)\s*\/\s*(\d+)/);

  return match ? { number: match[1], total: match[2] } : null;
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
  const parsedTitle = parseNumberAndTotal(product.productName);
  const collectorNumber =
    product.collectorNumber ?? parsedTitle?.number ?? null;
  const totalNumber = product.totalNumber ?? parsedTitle?.total ?? null;

  if (!collectorNumber || !numbersEqual(card.number, collectorNumber)) {
    return { kind: 'none', score: 0 };
  }

  const metadata = getPokemonSet(card.set);
  const expectedTotal = metadata?.mainSetTotal ?? null;

  if (expectedTotal !== null && totalNumber !== null) {
    if (!numbersEqual(expectedTotal, totalNumber)) {
      return { kind: 'none', score: 0 };
    }
  }

  const setCodeMatches =
    product.setCode !== null &&
    product.setCode !== undefined &&
    normalizeIdentityText(product.setCode) === normalizeIdentityText(card.set);
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
    product.setCode !== null &&
    product.setCode !== undefined &&
    /^[a-z]+\d+[a-z]*$/i.test(product.setCode) &&
    !setCodeMatches &&
    !collectionNameMatches &&
    !pokemonNameMatches
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
