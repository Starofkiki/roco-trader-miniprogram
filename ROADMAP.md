# Roadmap

This roadmap lists concrete maintenance work rather than promised release dates. Issues and small pull requests are welcome.

## Reliability

- Add repeatable WeChat DevTools build validation without exposing a maintainer AppID.
- Add adapter-level tests for cloud database pagination, transaction conflicts and timeout recovery.
- Document and test recovery procedures for a partially dispatched merchant round.

## Maintainability

- Split the large `rocoApi` entry point into catalog, history, subscription, notification and feedback modules while preserving action compatibility.
- Move remaining deployment-specific asset mapping behind documented configuration.
- Reduce generated snapshot review noise with deterministic summary tooling.

## Community and data quality

- Add issue templates for product corrections with source and reproduction fields.
- Record catalog provenance and update dates without copying private analytics or user data.
- Publish privacy-preserving operational health indicators only when they cannot identify users or expose deployment internals.

Good first contributions are documentation corrections, isolated regression tests and sourced catalog fixes. Larger changes should begin with an Issue so maintainers can agree on scope.
