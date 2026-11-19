# Phase 0 baseline

Goal `97e94b6a-60de-44e6-89d0-3b785f0b3a95`. This is a single-trial measurement of the unchanged editor, not a product acceptance test or a production gate. No numerical 50/500-page limits were supplied. The round-one harness could mistake an opaque white canvas for content. The first repair compared coarse layout but checked only the preceding bitmap for replay. The navigation repair compares independent raster appearances and keeps confirmed canvas history for the whole trial.

## Reproduce

With Node, the project's Playwright and its Chromium installed, provide Poppler `pdftoppm` on `PATH` for content checks. `pdfinfo` and `qpdf` provide separate output validation. From the repository root:

```sh
npm test
evidence="$PWD/.aic/phase0-navigation-repair"
mkdir -p "$evidence/artifacts"
BASELINE_CHROMIUM=1 BASELINE_CONTROL_REPORT="$evidence/white-control.json" \
  BASELINE_NAVIGATION_REPORT="$evidence/navigation-control.json" node --test tests/baseline.test.mjs
node scripts/corpus/verify.mjs

# Choose a new report path. Keep the directory named in artifactsDirectory.
run=$(mktemp -d)
TMPDIR="$evidence/artifacts" \
  node scripts/baseline/run.mjs --manifest tests/corpus/manifest.json \
  --output "$run/results.json" --timeout 8000 > "$run/run.log" 2>&1
```

`npm test` runs the unit predicates without requiring Chromium; use the opt-in command for actual browser controls. With the clean-room TypeScript control already installed outside this project, set `CLEAN_ROOM_TYPESCRIPT` to the installed TypeScript 5.9.3 `lib/typescript.js` before running `npm test`. The Chromium controls whiten initial render, reopen, and both on SYN-01, check the actual opaque-white canvas pixels, and require each affected stage to fail while unaffected stages pass. Marked SYN-01 and intentionally blank SYN-12 pass without injection. The maintained replay control writes previously drawn full-size page pixels back onto the visible main canvas after drawing, without changing readbacks or references. It checks direct page 1 → 25 replay, and page 1 → 50 plus page 25 → 1 in the same trial. It also checks normal 1/25/50/1 and two trials on a separate synthetic three-page document whose first two pages have byte-identical independent rasters, one with an intentional replay between those identical appearances. Evidence is local under `.aic/phase0-navigation-repair/`. Earlier QA evidence is preserved.

The runner checks every manifest member's size and SHA-256, submits those bytes through the public Open PDF chooser, and starts a new browser context per case. A rejected open gets a same-page recovery probe once a known-good control has passed. The harness rotates page 1 clockwise, captures the actual Download PDF file, confirms the save when offered, and reopens the downloaded bytes through the chooser on a fresh page. These later probes still run after a content mismatch when the app opened the file; saving or reopening cannot erase that mismatch. Conditional recovery and encryption alternatives are not exported. The local loopback server allows exact runtime URLs and bodyless GET/HEAD only, blocks service workers and WebSockets and counts denied attempts. Retained input/download paths in the JSON are relative to `artifactsDirectory`, which is relative to the repository when applicable. The PDF bytes stay local and are not tracked.

## What counts as visible content

1. **Independent expectation.** Run `LC_ALL=C pdftoppm -cropbox -scale-to 256 -singlefile -f N -l N INPUT.pdf` on the exact verified input, before timed browser actions. Store its version, diagnostics and SHA-256 of the raw P6 RGB pixel payload, not the header. For reopen, rotate the first-page reference pixels clockwise if the edit was confirmed; record the original input raster digest and the digest of the oriented pixel payload. The app's download is never the expected image. Intentional blank requires the manifest's `intentionallyBlank: true` and `pageMarkers[N-1]: null`, plus an all-white Poppler raster; unknown, unavailable and contradictory references cannot pass.
2. **Fresh canvas.** After the relevant public action, require the selected page and advertised count, a visible main `#canvas` with nonzero dimensions, and a backing-size attribute write or replacement observed after arming. A size write resets the backing bitmap even if the dimensions do not change. Reopen uses a fresh app page. A trial keeps every confirmed observed bitmap (sampled width, height and RGBA SHA-256) associated with its independent expected appearance (width, height and pixel SHA-256). Replaying any confirmed bitmap under a different expected appearance cannot pass, even across failures, intervening pages or reopen. Failed frames do not teach the history. A true return or two byte-identical independent rasters at the same dimensions can reuse the same observed image. History resets for a new input, including recovery probes. No thumbnail, private app state or page count alone is evidence of paint.
3. **Pixel checks.** Read the main canvas through a detached canvas resampled with high smoothing to a 256-pixel longest side. Require at least 99.5% of sampled pixels with alpha ≥250. Use darkness against white: `(255 - min(R,G,B)) * alpha / 255`. Nonblank requires darkness ≥24 in at least 0.015% of pixels across at least three cells of a normalized 32×32 grid. Absolute log aspect-ratio difference must be ≤0.035. Search each marked cell's one-cell Chebyshev neighborhood in the other image; require ≥72% of reference ink to have nearby observed ink and ≥50% of observed ink to have nearby reference ink, weighted by ink-pixel counts. Observed/reference ink fraction ratio must be 0.25–4 inclusive. A declared blank must have **zero** sampled nonwhite pixels after compositing against white, satisfy the same geometry/opacity checks, and show a fresh, stable bitmap.
4. **Distinguish similar pages.** At each measured performance render (including first render and reopen), compare against the other independently referenced page appearances with compatible aspect; edited reopen also considers page 1 before rotation. Byte-identical references at the same dimensions are equivalent, not rivals. Bilinearly sample composited RGB darkness on a common 128×128 grid. For a target `T`, rival `R` and observation `O`, let `D = sum(abs(T − R))` over the grid's channel values. Require mean `D` per channel ≥0.05 and margin `(sum(abs(O − R)) − sum(abs(O − T))) / D` ≥0.10 for every distinct comparable rival. Unchanged reference values cancel from the margin; near ties or weak signal are not matches. Missing planned references give an infrastructure failure rather than silently dropping a rival.
5. **Stability and errors.** Poll at approximately 25 ms and require an unchanged downsampled RGBA SHA-256, canvas size and backing generation for at least 60 ms across observations. Visible app errors take precedence; stable opaque wrong content at the deadline is `error`/mismatch with the last content evidence. Missing fresh/stable paint at the deadline is a timeout, never success. Missing usable reference after an accepted open is an infrastructure failure. `--timeout` is an observation budget, not a performance limit; a separate watchdog limits browser handling to 22 times that budget. Exit 0 means a report was written without recorded infrastructure failure, not that all cases matched; exit 2 reports infrastructure failures, and exit 1 means no completed report.

**Timings:** Open is the visible opened UI status and count only, not a content-verified open. Count a case as opened for the baseline only when open reports the expected page count **and** first render passes. First render and reopen are measured from file submission through stable content, including polling. Navigation times begin with the page-number or End/Home action. Save measures action through readback and SHA-256 of the completed browser download. Timings are Node monotonic milliseconds and include automation overhead. The reader preparation, initial chooser click and fresh page startup are excluded. Failures are not successful latency samples.

**Separate output checks:** Poppler `pdfinfo -f 1 -l 1` independently opens the input and saved bytes to check count and the first-page rotation delta. `qpdf --check` checks structure. Tool warnings, mismatches, unavailable and blocked validations are retained separately. The report records manifest and harness digests. The runtime SHA-256 is over a lexicographically sorted JSON array of `[relative POSIX path, SHA-256-of-bytes]` pairs for the 219 served assets.

**Limits:** This is a visual test, not OCR or proof of semantic or pixel-exact preservation. Renderer, font, annotation, antialiasing, color and subpixel differences can affect the scores. Exact replay history does not recognize every rescaled or altered image; the relative metric only compares known reference appearances and cannot identify every unseen wrong page or small loss. An identical reference proves only sampled appearance, not page-object identity or paint history. The harness checks page 1 for accepted samples and middle/last/return for the four performance inputs, not all pages in every document or all exported pages. No claim covers form interaction, metadata, later edits, thumbnail/zoom latency, process memory, repeat-trial performance, other browsers, physical devices, security, accessibility or release readiness.

## Recorded run

The [full JSON report](results.json) and [runner log](run.log) cover all 150 entries of manifest `fdaecccaf6f2dfdb27e1cfae0d2a40730129746ee632c0013139d1f5ac807d1a`. This run completed on 2026-11-19, 01:49:12–01:53:42 UTC, using Chromium 159.0.8154.6, Playwright 1.65.1, Node 26.13.0, Poppler 25.04.0 and qpdf 12.4.2 on macOS 27.2 (Apple M4, 10 logical cores, 32 GiB RAM). It recorded zero denied network attempts. All 219 runtime assets matched `bcfda7a`; runtime digest: `7baf56ea9d8bdc64df7082460902fd432d8e260c1c13e45ddd7c292c7a081ef9`.

**127 matches, 14 expected rejections, six alternatives, three mismatches, zero infrastructure failures.** The UI accepted 136 inputs; 135/150 were content-verified opens, including 129/130 valid unencrypted inputs. There were 130 captured downloads and 127 content-verified reopens. The separate output checks returned 128 confirmations, one mismatch, one warning, and 20 blocked checks. No expected rejection was counted as opened. See the JSON for the individual stages; totals are: open 136 successes / 14 errors; render 135 successes / 1 error / 14 blocked; save 130 successes / 20 blocked; reopen 127 successes / 3 errors / 20 blocked. All 12 performance navigation stages passed with page-identity evidence.

- **XRT-09:** app reopen rejected and independent output validation failed.
- **XRT-10:** reopen hit a visible page-render error and the structural checker warned.
- **XRS-09:** persistent raster disagreement. Both visible canvases were marked, but only 60% of reference ink had nearby observed ink versus the 72% minimum. The fixture's independent raster changes when annotations are hidden; the coarse measurement alone does not establish the cause. The mismatch is retained in both initial render and reopen.

### Performance observations (milliseconds)

| Case | Pages / workload | UI open | First content | Middle | Last | Return first | Save | Reopen content | Poppler reopen |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| PER-01 | 50 / vector-text-light | 217.2 | 374.4 | 261.1 | 190.4 | 107.1 | 278.5 | 439.0 | 22.5 |
| PER-02 | 50 / image-heavy | 208.5 | 452.9 | 202.3 | 222.5 | 134.8 | 165.7 | 301.2 | 19.9 |
| PER-03 | 500 / vector-text-light | 220.7 | 469.6 | 193.9 | 217.5 | 133.6 | 844.8 | 317.2 | 19.8 |
| PER-04 | 500 / image-heavy | 254.9 | 502.4 | 223.5 | 237.2 | 127.7 | 844.9 | 324.0 | 18.8 |

Report SHA-256: `ba7f30c076b0e9f38ddb04d30cb72718b1f8dba72a134aabe37f417b627ac9e9`. Log SHA-256: `e983f509a75c8aa5fce29b3ded2f27f53fbfb9cf3261068ccd052124dad039d8`.

Author verification reconciles the log, 150 retained inputs, 130 retained downloads, 144 fresh Poppler raster digests and derived rotations, report and provenance file hashes, and runtime equality. To repeat it in this worktree with the local evidence, run `python3 .aic/phase0-navigation-repair/verify.py` (`jsonschema` is required for the Draft-07 validation step). Independent provenance, similarity review and QA remain pending.
