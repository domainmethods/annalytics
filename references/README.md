# ReferenceCards

`references/` is the primary authoring surface for typed ReferenceCards.

The included `revenue.yml` file is starter sample content for template validation and tests. Replace it with implementation-specific cards before syncing File Search, running acceptance benchmarks, or deploying a real service. Do not commit client-specific warehouse schema, table names, business metrics, or private operating details back to the template repository.

Each implementation should choose one narrow high-confusion domain first, align the cards to that implementation's dbt artifacts, run `npm run knowledge:validate`, then sync with `npm run knowledge:sync`.
