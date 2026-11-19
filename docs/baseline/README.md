# Phase 0 baseline

Goal `97e94b6a-60de-44e6-89d0-3b785f0b3a95`. This is a single-trial measurement of the existing editor, not a product acceptance test or a production-gate pass. No numerical 50/500-page limits were supplied.

## Run

With the project's Playwright dependency and Chromium installed (`npm ci`; `npx playwright install chromium` during setup), run from the repository root:

```sh
npm test
node scripts/baseline/run.mjs --manifest tests/corpus/manifest.json --output docs/baseline/results.json --timeout 8000
```

Choose a new output path for each run; existing reports are not overwritten. CLI flags are also accepted via `npm run baseline -- ...`. `--timeout` sets the per-operation observation budget in milliseconds, not a performance target. A sample watchdog caps browser handling at 22 times that budget. Exit 0 means the report was written without recorded infrastructure failure, not that the app met every expectation; 2 means a report was written with infrastructure failures, and 1 means the run could not produce a report. A small manifest may be used for a smoke test; `summary.phase0Shape` distinguishes it from a manifest with 150 entries and both required performance scales. Compare `summary.byCategory` to the research matrix, not just the total count.

The runner handles every manifest entry in order. It checks input size and SHA-256 before submitting verified bytes through the visible **Open PDF** file chooser. Each sample starts in a new context; a rejected open also gets a same-page recovery check if an earlier fixture established a known-good control. The probe rotates page 1 clockwise, uses **Download PDF**, captures the actual browser file, confirms the save when offered, and reopens the downloaded file through a fresh editor page. The local scratch directory is printed to stderr; generated files there are not served or included in the report. The server only serves the runtime snapshot on loopback. The browser context permits only bodyless GET/HEAD requests for exact runtime URLs, blocks WebSockets and service workers, and records denied attempts.

## How to read the report

- **Open**: chooser submission to visible opened status, enabled download and reported page count. **First render** has the same start and ends at a visible, nonzero canvas with painted pixels. This is a paint probe, not a content comparison; it can succeed for a legitimately blank white page. **Reopen** measures chooser submission to first paint of the downloaded file, with the open-only time also recorded. Fresh page startup and the initial chooser click are outside successful open/reopen timings.
- **Save**: download button action to a completed nonempty browser file read back and hashed. **Navigation**: page-number entry or End/Home in the viewer to a newly sized, painted canvas with the requested page selected. Middle, last and return-to-first are measured for multi-page performance cases. Timings are monotonic milliseconds including UI automation and observation overhead. They are not engine-only timings; failures and timeouts are censored observations, not latency measurements of successful operations.
- **Expected rejection** requires an explicit app error in a stage expecting an error. `blocked` means a prerequisite was not met, not that a check succeeded. Error text, broad error class and stage-level comparisons are retained. Mismatches include unexpected outcomes, wrong page totals or a failed independent output check. Timeouts and infrastructure failures are never counted as successful outcomes. `match` does not certify semantic preservation.
- **Second reader**: if available, Poppler `pdfinfo -f 1 -l 1` opens the input and saved bytes independently and checks page count and the first-page rotation delta. qpdf `--check` is a separate structural check. Versions, exit codes, sanitized diagnostics and elapsed times are kept; tool warnings, unavailable tools, unconfirmed validations and blocked validation are separate from confirmed checks. No CLI substitutes for browser open, save or reopen.
- **Identity**: the report records the observed commit, the manifest digest, and hashes of the harness scripts. The runtime SHA-256 is over a lexicographically sorted JSON array of `[relative POSIX path, SHA-256-of-bytes]` pairs; the same algorithm is applied to the commit blobs and the actual served bytes. A later docs-only integration commit should retain the same runtime digest.

The baseline does not verify fixture-specific glyphs, color swatches, annotations, forms, metadata, all-page fidelity, edit coverage beyond first-page rotation, thumbnail/zoom latency, process memory, warm cache behavior, or physical devices. It uses one headless desktop Chromium trial per fixture in manifest order, with no warm-up, blocked service workers, `no-store` HTTP responses and uncontrolled OS/process caches. Exact host, browser and reader versions are in the JSON. No tail/median, native, security, accessibility or release claims are made.

## Recorded runs

The [full JSON report](results.json) and [runner log](run.log) cover all 150 entries of the measured manifest (`fdaecccaf6f2dfdb27e1cfae0d2a40730129746ee632c0013139d1f5ac807d1a`). The run took place on 2026-11-19, 00:55:49–00:59:17 UTC, on macOS 27.2 (Apple M4, 10 logical cores, 32 GiB RAM), using Chromium 159.0.8154.6, Playwright 1.65.1, Node 26.13.0, Poppler 25.04.0 and qpdf 12.4.2. It recorded zero denied network attempts under the loopback-only configuration. The runtime matched commit `bcfda7a21d75af4e5c65cbaa4a1d7e4580cb3f22` byte for byte across 219 assets: `7baf56ea9d8bdc64df7082460902fd432d8e260c1c13e45ddd7c292c7a081ef9`.

| Manifest category | Total | Match | Expected rejection | Alternative observed | Mismatch | Infra failure |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Syntax | 12 | 12 | 0 | 0 | 0 | 0 |
| Xref table | 10 | 8 | 0 | 0 | 2 | 0 |
| Xref stream | 10 | 10 | 0 | 0 | 0 | 0 |
| Object stream | 8 | 8 | 0 | 0 | 0 | 0 |
| Incremental | 10 | 10 | 0 | 0 | 0 | 0 |
| Page tree | 16 | 16 | 0 | 0 | 0 | 0 |
| Text | 14 | 14 | 0 | 0 | 0 | 0 |
| Graphics | 12 | 12 | 0 | 0 | 0 | 0 |
| Image | 12 | 12 | 0 | 0 | 0 | 0 |
| Annotation | 8 | 8 | 0 | 0 | 0 | 0 |
| Form | 8 | 8 | 0 | 0 | 0 | 0 |
| Metadata | 6 | 6 | 0 | 0 | 0 | 0 |
| Encryption | 10 | 0 | 8 | 2 | 0 | 0 |
| Malformed | 10 | 0 | 6 | 4 | 0 | 0 |
| Performance | 4 | 4 | 0 | 0 | 0 | 0 |
| **Total** | **150** | **128** | **14** | **6** | **2** | **0** |

136/150 opened and reached first paint, including 130/130 cases outside the encryption and malformed categories. 130 downloaded and 128 reopened and painted. `XRT-09` failed to reopen in the app and failed independent output validation. `XRT-10` reopened but could not paint, and independent validation recorded a warning. The six alternatives opened and painted, but export and reopen were intentionally not attempted because marker agreement or export permissions were not established. This is separate from a match, and no restrictions were bypassed. Independent validation recorded 128 confirmations of the limited page-count/rotation checks, one mismatch, one warning, and 20 blocked checks. The actual manifest allocation, not the proposed research matrix, is reported above.

### Performance observations (milliseconds)

| Case | Pages / workload | Open | First paint | Middle | Last | Return to first | Save | Reopen to paint | Poppler reopen |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| PER-01 | 50 / vector-text-light | 222.2 | 234.5 | 280.5 | 285.2 | 196.6 | 299.6 | 144.0 | 105.3 |
| PER-02 | 50 / image-heavy | 189.0 | 299.0 | 206.5 | 340.6 | 150.9 | 289.0 | 155.7 | 17.6 |
| PER-03 | 500 / vector-text-light | 142.9 | 153.9 | 205.8 | 269.3 | 187.9 | 883.7 | 252.7 | 17.4 |
| PER-04 | 500 / image-heavy | 146.1 | 278.7 | 206.7 | 178.0 | 120.8 | 728.8 | 173.1 | 19.3 |

Author verification included `npm test`, the existing `npm run test:browser` used as a black box, a generated smoke specimen, runtime allowlist checks, and a post-run check of all fixture hashes, manifest identity, report coverage, and harness/runtime digests. Two earlier runs used superseded manifest revisions during integration and are not used for these numbers. Independent review remains pending.
