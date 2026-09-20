import type {
  ProviderDescriptor,
  ProviderName,
  ProviderStrategy,
} from './types.ts';

/**
 * Provider registry.
 *
 * Keep provider availability and browser metadata here rather than scattering
 * provider names, hostnames and start URLs across CLI parsing and workflows.
 * Every implemented provider gets a reusable tab during startup, whether or
 * not that provider is selected for the current run.
 */
export const PROVIDER_REGISTRY: Record<ProviderName, ProviderDescriptor> = {
  dorasuta: {
    name: 'dorasuta',
    label: 'Dorasuta',
    implemented: true,
    hostname: 'dorasuta.jp',
    homeUrl: 'https://dorasuta.jp/pokemon-card',
  },
  pao: {
    name: 'pao',
    label: 'PAO',
    implemented: true,
    hostname: 'pao-onlineshop.com',
    homeUrl: 'https://pao-onlineshop.com',
  },
  manasource: {
    name: 'manasource',
    label: 'ManaSource',
    implemented: true,
    hostname: 'manasource.net',
    homeUrl: 'https://www.manasource.net',
  },
  toreca: {
    name: 'toreca',
    label: 'Toreca',
    implemented: true,
    hostname: 'torecacamp-pokemon.com',
    homeUrl: 'https://torecacamp-pokemon.com',
  },
};

/** Parse a provider list while preserving its declared order. */
export function parseProviderSelection(value: string): ProviderName[] {
  const requested = value
    .split(',')
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean);

  if (!requested.length || requested.includes('all')) {
    return Object.values(PROVIDER_REGISTRY)
      .filter((provider) => provider.implemented)
      .map((provider) => provider.name);
  }

  const unknown = requested.filter((name) => !(name in PROVIDER_REGISTRY));

  if (unknown.length) {
    throw new Error(
      'Unknown provider(s): ' +
        unknown.join(', ') +
        '. Available providers: ' +
        Object.keys(PROVIDER_REGISTRY).join(', ') +
        '.',
    );
  }

  const unavailable = requested.filter(
    (name) => !PROVIDER_REGISTRY[name as ProviderName].implemented,
  );

  if (unavailable.length) {
    throw new Error(
      'Provider adapter not implemented yet: ' + unavailable.join(', ') + '.',
    );
  }

  return [...new Set(requested)] as ProviderName[];
}

/** Parse the offer distribution strategy exposed by the CLI. */
export function parseProviderStrategy(value: string): ProviderStrategy {
  const strategy = value.trim().toLowerCase();

  if (strategy !== 'all' && strategy !== 'cheapest') {
    throw new Error(
      'Unknown provider strategy: ' + value + '. Use all or cheapest.',
    );
  }

  return strategy;
}
