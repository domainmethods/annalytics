# ReferenceCards

`references/` is the primary authoring surface for typed ReferenceCards.

The starter sample cards live in `references/examples/` (currently `examples/revenue.yml`) for template validation and tests. They are not live-loaded: the loader reads only `references/*.yml`, not subdirectories. Author implementation-specific cards directly in `references/` — by convention as `references/<domain>.live.yml`, which is gitignored — before syncing File Search, running acceptance benchmarks, or deploying a real service. Do not commit client-specific warehouse schema, table names, business metrics, or private operating details back to the template repository.

Each implementation should choose one narrow high-confusion domain first, align the cards to that implementation's dbt artifacts, run `npm run knowledge:validate`, then sync with `npm run knowledge:sync`.
