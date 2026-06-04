# Mock ReferenceCard Acceptance Results

These files exercise the deterministic ReferenceCard acceptance analyzer without
calling Gemini, BigQuery, Firestore, or File Search.

- `2026-06-04-referencecard-accepted.json` is a mock run that should produce
  `ACCEPTED`.
- `2026-06-04-referencecard-needs-revision.json` is a mock run that should
  produce `NEEDS_REVISION`.

The generated `*-summary.md` and `*-referencecard-acceptance.md` files are
checked in to make the analyzer output shape inspectable.

These mocks do not satisfy the live Revenue ReferenceCard Acceptance Run in
`docs/trajectory-governance.md`. Real acceptance evidence must still come from
a saved benchmark JSON under `benchmarks/results/`.
