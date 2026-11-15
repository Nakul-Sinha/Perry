# Static fixture baseline

Run the deterministic local review across the 20 synthetic Git comparisons:

```sh
pnpm check:baseline
pnpm check:baseline --details
pnpm check:baseline --json
```

The default output lists every comparison and totals for detected defect cases, labeled root causes, misses, false findings, duplicate findings, and clean-case false blocks. `--details` includes both original comment bodies for every case. JSON includes the same raw reports and per-case accounting for inspection or comparison between revisions.

The command calls the existing fixture entry point without model or execution flags. It does not use API access, execute the application, or verify GitHub prerequisites. Each comparison is materialized as temporary base/head commits and reviewed using the same local CLI as the fixture tests.

## Labels and counting

`tools/fixtures/expectations.ts` is the shared independent label source for both the existing comparison tests and this command. It remains outside the temporary repository being reviewed. No label or expected result is passed to the reviewer.

- A finding label or known-miss label defines one expected root cause. A match must satisfy its claim pattern and any required pinned source location. Multiple matching findings count once as a detected root and are also reported as duplicates.
- Other findings in a labeled defect/clean comparison count as false findings against these fixture labels. Keep the raw reports available for human adjudication before changing the labels or claiming an error in the reviewer.
- A limitation-only comparison is a coverage gap, not a clean case. Findings there are unscored and printed for inspection. Missing the expected limitation is reported separately.
- A comparison with neither a defect nor a limitation label is a clean control. An incorrect `DO NOT MERGE` recommendation there counts as a clean-case false block. HOLD due to missing live prerequisites is not a false block.
- A process failure or malformed report is an evaluation error. Its expected root remains unevaluated rather than being silently treated as clean or as an ordinary missed bug.

Exit status 0 means all comparisons produced parseable reports, not that every bug was detected or a quality threshold passed. Evaluation/process errors exit 1; invalid arguments exit 2. There are no quality thresholds or paid model calls in this baseline.

These are development comparisons with narrow labels and one root per defective case. Their counts are useful for regression tracking and locating known misses. They are not a held-out estimate of general precision, recall, or industry readiness.
