# Independent annotation runtime provenance review

- Goal `606aea52-61e9-4831-8a66-cc24f0367fa8`, revision 3; base `856a184cfc3f0bafcbf1c51ae1cd6dec8d8399f7`.
- Reviewer: `work-0e0752a8-2d9c-4ca1-9d61-d3a5a6698a0b`, Independent annotation tests and provenance integration, 2026-11-20 UTC. Dispatcher generation `239f591b-90ec-458b-9c50-e1e12d66c662`.
- Scope: **approved for runtime provenance only**, for the eight raw SHA-256 fingerprints in [the record](../annotations.json). The reviewer wrote the new browser tests and documentation, but none of the runtime files under review. This does not sign off the tests, standing QA, release licensing, security, or owner review.

The approval above is historical; it does not revise the historical S3a goal outcome.

## S3b integration — current

Reviewer: `work-01f98a83-c2aa-4768-b0e1-fa98d2b539de`, 2026-11-20. Reviewed runtime integration for the current raw digests in [annotations.json](../annotations.json). `src/shapes.js` matches base. Reviewed crop/blank projections, gesture ownership and the preserved managed-annotation export/import path; ordinary PDF stamps are not rehydrated as managed marks. Foreign note and form remained on the expected pages in the two-reader workflow. No runtime repair or annotation driver edit by this reviewer.

The B0 driver bytes (`ebdf48c17138c7f3f41f80cc113d7ca36c19c74a7d4c47035aa5a9814f7a36c1`) ran 8/8 unchanged on the integrated runtime. It observed an activated `/sw.js`, the real scope/revision CacheStorage key, and 222/222 current manifest URLs, then exported an offline shape with the HTTP server stopped. Native six-shape restore, its negative controls, and the existing AX/keyboard checks passed. Attributed driver integration: `work-9558ce5d-e1b0-4f73-85b0-6ea6935ae831`. This review is not standing QA, approval of my own tests, or a license, security, release or owner sign-off.

## Historical S3a derivation and integration

Recomputed all eight SHA-256 digests in the dispatched snapshot before testing. They match the W-shapes producer record. The [producer ledger](../../notes/annotations-spec.md) preserves the original selection author (`work-adb87329-be69-40a6-bed0-aed6db43e892`), the admission and hex-field contributor (`work-a462ddd3-dd69-4075-94d5-7e37f60c85e1`), and the shape and appearance author (`work-c972bba2-40dd-4a87-a718-25b072edd66b`). Historical D1 UNKNOWN was not reclassified.

Reviewed the runtime deltas against the base: page and mark identities, cloned insertion and immutable transforms, capture and cancellation, CSS-viewport handles, options and keyboard routing, and PDF export/import. `src/shapes.js` uses local region/line geometry and projects through the existing viewer viewport. `src/pdf.js` uses bundled pdf-lib APIs for standard annotation subtypes and Form XObject appearances. Reopen retains original bytes for file identity; the working copy detaches only recognized, bounded, versioned payloads with a matching subtype and namespaced ID. Its reference walk retains shared objects. The private metadata is not an authenticity check. Ordinary foreign annotations and original page content are not intentionally converted to editable items. The strict Save module stayed unchanged; see the [Save integration review](save.md).

Producer sources are local requirements, owned code, and observed results of the existing PDF readers. No external implementation was identified in the reviewed deltas; this is not a similarity scan or independent verification of the authors' browsing history. The dependency lock, vendored readers, notices and licence inventory are unchanged. Axe-core was not used; its MPL-2.0 license is outside the allowlist. Manual inspection and local regression evidence are not a full licence or accessibility audit.

## Independent observations

- Eight public-UI selection sequences: four kinds in Chromium and WebKit touch emulation. Tap/click selection did not edit the model. Counts stayed `1→1→1→1` through move, resize, nudge and applicable restyling, then went to `0` on delete. Undo and redo compared entire models including the typed image bytes. Canceled move left no commit. Sixteen hit-tested handles measured at least 45.999 CSS px at Fit.
- Both browsers created all six new tools in one PDF. Each of six downloaded files (three generations per browser) passed the unchanged standalone validator. PDF.js and pdf-lib each identified Underline, StrikeOut, Square, Circle, a plain Line and a Line with OpenArrow, plus the untouched foreign Text note. Six stable identities, 16 rendered color/background assertions per export and a clean base canvas on app reopen confirmed no second paint in the tested scenario. An edit between generations persisted.
- Playwright AX inventory: 411 Chromium and 284 WebKit role/name observations across main views and panels, with 59 and 64 visible-focus checks. Keyboard actions verified all six palette buttons, width/color/place, item selection, viewer-arrow movement, all four nudge buttons, resize buttons, color/size changes, delete, undo/redo, Escape and More open/close. Each engine detected both an unnamed AX node and a removed keyboard-action handler. The hex input supplies keyboard color editing; native picker UI was not exercised.
- The unchanged desktop offline group and a separate server-stopped Chromium shape-edit/download both passed. See the [Save integration review](save.md) for the unchanged suite counts. Artifacts from `npm run test:annotate` are synthetic PDFs, AX snapshots, JSON and focus screenshots under ignored `test-results/annotation-*`.

WebKit touchscreen taps use Playwright input; its drags use dispatched touch pointer streams, not native device capture or gestures. The review makes no claim about physical devices, native assistive technology, full PDF conformance including externally modified appearances, or release readiness.
