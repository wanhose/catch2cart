# catch2cart

Tool for reading wishlist providers, finding matching products across selected product providers, and adding only the required quantities to their carts.

The project runs against an existing Chromium-based browser session through Playwright CDP. It starts in `dry-run` mode and requires `--commit` before making cart changes.

## Requirements

- Node.js 24 or newer.
- pnpm 12.4.2 or compatible.
- A Chromium-based browser started with remote debugging at `127.0.0.1:9222`.
- One browser window in the same session. Keep Cardmarket open and logged in; catch2cart opens a missing product-provider tab automatically.
  - Cardmarket: `https://www.cardmarket.com/en/Pokemon/Wants`
  - Supported product providers: Dorasuta (`https://dorasuta.jp/pokemon-card`), PAO (`https://pao-onlineshop.com`), ManaSource (`https://www.manasource.net`) and Toreca (`https://torecacamp-pokemon.com`). Their tabs are created automatically when missing.

catch2cart reuses existing provider tabs. If a product-provider tab is missing, it opens one for every implemented product provider during startup, including providers not selected for the current run. Log in and complete any verification manually before starting it when possible, and keep the browser open while it runs.

## Start a Chromium-based browser with CDP

Use a separate browser profile so an already-running browser process does not prevent the debugging port from being enabled. The executable name depends on the browser and operating system.

Chromium:

```bash
chromium \
  --remote-debugging-port=9222 \
  --user-data-dir="$PWD/.chromium-profile"
```

Google Chrome:

```bash
google-chrome \
  --remote-debugging-port=9222 \
  --user-data-dir="$PWD/.chromium-profile"
```

Microsoft Edge:

```bash
microsoft-edge \
  --remote-debugging-port=9222 \
  --user-data-dir="$PWD/.chromium-profile"
```

Brave:

```bash
brave-browser \
  --remote-debugging-port=9222 \
  --user-data-dir="$PWD/.chromium-profile"
```

Vivaldi:

```bash
vivaldi \
  --remote-debugging-port=9222 \
  --user-data-dir="$PWD/.chromium-profile"
```

Opera:

```bash
opera \
  --remote-debugging-port=9222 \
  --user-data-dir="$PWD/.chromium-profile"
```

On macOS and Windows, replace the executable with the browser's full application path when it is not available on `PATH`. Common names include `Google Chrome`, `Microsoft Edge`, `Brave Browser`, `Vivaldi`, and `Opera`.

Open Cardmarket in that window, complete any login or Cloudflare verification manually, and then run the script. Missing product-provider tabs are opened automatically.

Install dependencies:

```bash
pnpm install
```

## Usage

Run in dry-run mode:

```bash
pnpm start
```

Allow real cart changes:

```bash
pnpm start -- --commit
```

The script reads wishlists, verifies set and collector number, checks the existing cart to prevent duplicates, and adds only the missing quantity.

## Japanese cards only

catch2cart currently supports **Japanese Pokémon cards only**. Its product providers sell Japanese inventory, and the matching rules rely on Japanese set codes, collection names, and card totals.

This focus is intentional: Japanese singles can sometimes be listed on marketplaces such as Cardmarket at substantial reseller mark-ups compared with their local price in yen. Finding even one such card at Dorasuta or ManaSource can make placing an order worthwhile.

When multiple product providers are selected, the final report reads each cart total and wishlist coverage independently. It also lists the cards added or planned per provider. Totals include products already present in those carts, not only items added during the current run.

Before searching, catch2cart checks all selected provider carts together. A card whose requested quantity is already complete in any one of those carts is marked as already in cart globally and is not searched or added to another provider.

## Providers

catch2cart separates two provider roles:

Provider adapters in `src/providers` contain site-specific parsing and browser
primitives. Their end-to-end cart workflows live in
`src/providers/workflows`. Wishlist ingestion is kept separately under
`src/inputs`, while `src/main.ts` coordinates providers without owning their
site-specific matching or cart logic.

| Role              | Current provider | Responsibility                                                                                                                       | Status                         |
| ----------------- | ---------------- | ------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------ |
| Wishlist provider | Cardmarket       | Reads Wants lists and requested quantities.                                                                                          | Supported                      |
| Product provider  | Dorasuta         | Searches products, validates identity and stock, and manages the cart.                                                               | Supported in the main workflow |
| Product provider  | ManaSource       | Searches direct keywords or collections, reads stock and quantities, and exposes its own cart flow.                                  | Supported in the main workflow |
| Product provider  | PAO              | Searches Japanese product names, validates collector number and set total, and manages its own cart.                                 | Supported in the main workflow |
| Product provider  | Toreca           | Searches Shopify product listings, ignores graded/PSA cards, validates collector number and set total, and only accepts condition A. | Supported in the main workflow |

Wishlist providers are the sources of the cards to buy. Product providers are the shops where matching products and carts live. They are configured separately so adding another shop does not require changing wishlist parsing.

Select product providers with --providers and choose the distribution strategy with --provider-strategy:

    # Default product-provider selection
    pnpm start

    # Explicitly use Dorasuta
    pnpm start -- --providers dorasuta

    # Use every implemented product provider
    pnpm start -- --providers all --provider-strategy all

    # Compare normalized offers and select the cheapest one
    pnpm start -- --providers all --provider-strategy cheapest

all means every implemented product provider selected by the registry. Dorasuta, PAO, ManaSource and Toreca are currently enabled in the main workflow. cheapest compares eligible offers using known item price and stock, then selects the lowest-priced offer. Shipping costs are not included yet. Provider-specific rate limits and Cloudflare settings remain separate because they describe a particular shop, not the provider strategy.

Product URLs are stored in the provider-neutral product cache. Each provider only reads URLs belonging to its own hostname.

### Japanese set metadata cache

The first run downloads public set metadata and stores each code, English name, Japanese name and main-set total in `.set-cache`. It uses the same TTL as `.product-cache` (24 hours by default), so no hand-maintained set dataset is required.

ManaSource matches require a collector number plus a Japanese collection name from that cache. If it is stale, catch2cart refreshes it in a temporary metadata tab and closes that tab immediately. When a Dorasuta product lacks its set code, the fallback remains deliberately conservative: one search candidate and a self-consistent collector number, total and model number are required.

## Navigation and verification

The script includes delays between navigations and searches. The default navigation gap is 10 seconds and the Dorasuta search gap is 15 seconds. If a provider presents a Cloudflare verification page, it waits for the verification to finish and allows it to be completed manually in the browser window.

Dorasuta-specific rate-limit pages and cart-full responses stop or delay only the Dorasuta flow. The script does not attempt to bypass site controls.

## Local execution and privacy

This project runs locally on your computer. It does not use a project-owned API, telemetry service, analytics endpoint, remote database, or data-collection backend. It does not send your wishlist, credentials, or cart contents to the author or to any third-party service operated by this project.

The script only drives the browser session you explicitly connect through CDP. Network requests go directly from that browser to the selected wishlist and product providers. Authentication cookies remain in your local browser profile, and generated cache files remain local and are ignored by Git.

No browser is closed automatically, no credentials are read from disk by the script, and no local data is uploaded by the project. Use a profile you control, review the source, and follow the terms and rate limits of the websites involved.

## AI-assisted development

AI tools may be used as complementary support during the development and maintenance of this project. They are not part of catch2cart's runtime, and the script does not send wishlist data, product data, credentials, or execution results to an AI service.

The matching, provider selection, cache handling, cart updates, and final results are produced by the project's source code, provider pages, deterministic rules, and the data returned by the websites themselves. No result depends on an AI-generated decision while the script is running.

## Caches

### Wishlist cache

Use --use-wishlist-cache to reuse or create .wishlist-cache:

    pnpm start -- --use-wishlist-cache

Refresh it automatically after a maximum age:

    pnpm start -- --use-wishlist-cache --wishlist-cache-ttl-hours 24

Use --clear-wishlist-cache to remove it before the run. The old Cardmarket-named flags remain accepted as compatibility aliases.

Skip one or more Cardmarket lists by ID or full URL:

    pnpm start -- --skip-cardmarket-wishlists 25463107,25463108

The wishlist cache stores normalized cards with `wishlistUrls` and `wishlistIds` source arrays. Duplicate wishlist entries use the maximum requested quantity, never a sum. When `--skip-cardmarket-wishlists` is used with the cache, cards whose source IDs are all skipped are excluded before processing.

### Product cache

Use --use-product-cache to reuse or create the provider-neutral .product-cache:

    pnpm start -- --use-product-cache

Cached product availability is invalidated after 24 hours by default. To configure it explicitly:

    pnpm start -- --use-product-cache --product-cache-ttl-hours 24

Each card may contain URLs for multiple product providers and a generic search term:

    {
      "version": 1,
      "products": {
        "sv8:115:perrin": {
          "urls": [
            "https://dorasuta.jp/pokemon-card/product?pid=123456",
            "https://www.manasource.net/product/123456"
          ],
          "searchName": "フワンテ 111/103",
          "source": "manual",
          "productName": "フワンテ 111/103"
        }
      }
    }

URLs are additive and deduplicated. Cached URLs are filtered by provider before inspection. Legacy single-url entries and old cache filenames are migrated automatically; legacy names are not the recommended configuration.

Prefer a generic searchName such as フワンテ 111/103 over provider-specific punctuation such as フワンテ(111/103). When a provider returns no collector-number match or cannot verify the set, that negative result is cached per provider too; no incorrect product URL is stored, and the result expires with the same product-cache TTL. Product availability checks can also be cached with --product-cache-ttl-hours; a cached zero-stock result is skipped until that TTL expires. The default product-cache TTL is 24 hours.

Use --clear-product-cache to remove the product cache and force a fresh set cache when a product provider is selected. The automatically managed `.set-cache` uses the same product-cache TTL; it is recreated from public metadata whenever it is stale. The old Dorasuta-named product-cache flags remain accepted as compatibility aliases.

Use both caches together:

    pnpm start -- --use-wishlist-cache --use-product-cache

## Options and configuration

| Option                            | Default               | Purpose                                                            |
| --------------------------------- | --------------------- | ------------------------------------------------------------------ |
| --commit                          | disabled              | Actually add products to carts.                                    |
| --verbose                         | disabled              | Keep detailed diagnostic output.                                   |
| --no-dashboard                    | disabled              | Disable the interactive dashboard.                                 |
| --current-wishlist                | disabled              | Process only the currently open wishlist.                          |
| --skip-cardmarket-wishlists       | none                  | Skip wishlist IDs or URLs separated by commas.                     |
| --providers                       | all                   | Product providers to use, comma-separated.                         |
| --provider-strategy               | all                   | Populate all selected providers or choose the cheapest offer.      |
| --max-price-yen                   | none                  | Ignore offers above this per-card price.                           |
| --batch-size                      | 0                     | Process this many distinct cards per batch; 0 means all.           |
| --batch-number                    | 1                     | Select a 1-based batch number.                                     |
| --use-wishlist-cache              | disabled              | Reuse or create .wishlist-cache.                                   |
| --clear-wishlist-cache            | disabled              | Delete .wishlist-cache before running.                             |
| --wishlist-cache-ttl-hours        | 0                     | Refresh wishlist cache after this age.                             |
| --use-product-cache               | disabled              | Reuse or create .product-cache.                                    |
| --product-cache-ttl-hours         | 24                    | Recheck cached stock after this age; 0 explicitly disables expiry. |
| --clear-product-cache             | disabled              | Delete .product-cache before running.                              |
| --wishlist-cache-file             | .wishlist-cache       | Wishlist cache path.                                               |
| --product-cache-file              | .product-cache        | Provider-neutral product cache path.                               |
| --cdp-endpoint                    | http://127.0.0.1:9222 | Browser CDP endpoint.                                              |
| --navigation-gap-ms               | 10000                 | Minimum delay between navigations.                                 |
| --navigation-retry-attempts       | 2                     | Additional attempts for transient navigation failures.             |
| --cloudflare-poll-ms              | 3000                  | Cloudflare polling interval.                                       |
| --cloudflare-max-wait-ms          | 600000                | Maximum Cloudflare wait.                                           |
| --dorasuta-search-gap-ms          | 15000                 | Minimum delay between Dorasuta searches.                           |
| --dorasuta-rate-limit-retry-ms    | 60000                 | Wait between Dorasuta rate-limit retries.                          |
| --dorasuta-rate-limit-max-wait-ms | 900000                | Maximum wait for a Dorasuta rate-limit page.                       |

Numeric options are expressed in milliseconds where applicable. All options support both --option value and --option=value forms. Numeric settings also accept their documented uppercase environment variables.

Dorasuta-only options such as --dorasuta-search-gap-ms, --dorasuta-rate-limit-retry-ms and --dorasuta-rate-limit-max-wait-ms are intentionally provider-specific.

## Development

Run the validation suite with:

    pnpm test
    pnpm run lint
    pnpm run format:check

Node 24 executes the TypeScript files directly using native type stripping. The typecheck script performs static checking separately.

### Tests

The test suite uses Node’s built-in node:test runner. Tests cover wishlist parsing and merging, provider-neutral cache keys and migration formats, product matching, quantity selectors, stock handling, and provider strategy selection.

Browser/CDP integration depends on a real logged-in browser session and should be exercised manually with dry-run mode.

### Runtime flow

1. The selected wishlist provider collects and merges requested cards.
2. Every implemented product provider has a browser tab prepared; selected providers then read their own cart state.
3. The provider-neutral product cache is checked before a live search.
4. Each provider validates product identity, price, stock and current cart quantity using its own adapter.
5. The configured provider strategy distributes all eligible offers or selects the cheapest one.
6. Commit mode adds only missing quantities and reports partial stock without overfilling carts.

## License

This project is distributed under the [MIT License](LICENSE).
