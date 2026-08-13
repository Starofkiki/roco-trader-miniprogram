# Architecture

## System boundaries

The mini program is a read-oriented client. It never receives maintenance secrets and it does not query production collections directly. Both player and administrator actions pass through WeChat cloud functions.

```text
WeChat Mini Program
  -> rocoApi (player operations)
  -> rocoAdminApi (allowlisted maintenance operations)
       -> WeChat Cloud Database
       -> remote merchant data source
       -> WeChat subscription-message API
```

## Data flow

1. Scheduled jobs fetch the current merchant round and write an idempotent history record.
2. A recoverable delivery queue matches enabled subscriptions against the round.
3. Each delivery is deduplicated by user, template and round; temporary failures receive limited retries.
4. The client reads current data, bundles and generated catalog snapshots through narrow cloud-function actions.
5. If a current read is unavailable, the client can fall back to history or the generated catalog snapshot.

## Catalog pipeline

`tools/catalog/build-product-catalog.js` combines the reviewed product source, offer configuration and stable product-ID map. It generates identical fallback modules for the client and both cloud functions. CI uses `--check` and regression scripts to prevent stale or divergent snapshots.

Generated migration reports are local artifacts and are intentionally ignored by Git.

## Privacy and security boundaries

- Identity-bearing fields such as openid remain in restricted cloud collections.
- App secrets, remote API keys and maintenance secrets are cloud-function environment variables.
- Public deployment identifiers are configured locally in `deployment.config.js`; the committed file contains empty placeholders.
- Production logs, analytics, subscription aggregates and database exports are excluded from the repository.
- Administrator actions require both server-side authorization and explicit confirmation for high-impact operations.

## Test strategy

`npm test` checks JavaScript syntax, generated catalog consistency, history/cache behavior, page data transforms, notification queue semantics, retry handling and cloud-I/O optimizations. WeChat DevTools integration and cloud-database behavior still require a configured development environment; see [`ROADMAP.md`](ROADMAP.md).
