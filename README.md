# Paperplane — Local PDF Studio

> **Beta.** Desktop and mobile editing are covered by automated browser tests. Real-device behavior may vary.

Paperplane is a static, browser-first PDF editor. It reads files, renders pages, and generates new PDFs locally. There is no upload, no account, and no frontend build. Working PDFs are held in memory. Recovery drafts and original-file backups may also be stored privately by this browser; they are not part of the offline asset cache.

## Run locally

With Node.js 22 or later:

```sh
npm start
```

Open `http://127.0.0.1:8080/`. The static server needs no npm install. Set `PORT` to override the port. For other static hosting, serve the runtime files (`index.html`, `style.css`, `manifest.webmanifest`, `sw.js`, `precache.js`, `icons/`, `src/`, and `vendor/`) from the same directory using HTTPS and the correct JS, CSS, manifest and WASM MIME types. Do not expose internal repository files. Opening the HTML as a `file:` URL is not supported.

Wait for **Offline ready** on the first online visit. Afterwards the app can reload and work without a connection while the browser retains its cache. In browsers that offer installation, use **Install** or the browser’s install menu. On platforms that support installed PWA PDF associations, open one local PDF with Paperplane; otherwise use the file picker or drop a PDF onto the workspace.

## Edit a PDF

- Select a thumbnail, enter a page number, or focus the viewer and use Left/Right or Home/End. Zoom is relative to the fit-width view. Only the selected page is rendered at full size; thumbnail canvases are created only for visible tiles.
- Choose **Text**, enter the note, and click/tap its baseline or use **Place at page center**. **Draw** and **Highlight** take a pointer, pen, or touch stroke. **Image / Signature** places a PNG or JPEG, including scanned signatures. Images are normalized by the browser and limited to 2,400 pixels on their longer side. Draw is also suitable for visual signatures.
- Rotate clockwise, move pages earlier/later, or delete all but the final page. **Merge PDF** appends another file; **Extract pages** downloads a separate copy of your selection in displayed order, e.g. `1, 3-5`. Extraction does not change the open document.
- **Fill forms** lists the plain fields from the PDF that supplied the selected page. Apply text, checkbox, radio, dropdown or list changes as one edit. Use **Undo**/**Redo** (up to 100 recent edits) or Ctrl/Cmd+Z and Ctrl/Cmd+Shift+Z. Ctrl/Cmd+S uses the current save mode.

## Save and recover

- **Overwrites the original** appears when **Open PDF** connects a writable file handle. **Save original** checks for an external change and offers **Reload from disk**, **Overwrite anyway**, or **Save a copy**. The app must write and verify a private backup before overwriting; it then rereads and validates the written PDF. If verification fails, it attempts to restore the backup and reports the outcome. If backup storage fails or permission is denied, use **Save a copy** instead. The browser file API cannot prevent another app from writing in the final check-to-close window.
- **Saves a copy** applies to HTML file input, drag-and-drop, and browsers without the picker. **File options** (under **More** on phones) offers **Save a copy** even when an original is connected. Check the `-edited.pdf` copy before selecting **I saved this copy**; a requested download or share is not proof that a copy was saved. **Share copy** appears when the browser can share PDF files. Where a download is unavailable, **Open prepared PDF** provides a separate route to the viewer and its Save to Files options. Sharing can send the copy outside the device to the destination you choose.
- Dirty edits request the browser's navigation warning. The app attempts a local autosave about every 10 seconds while active. On relaunch, **Recover workspace** opens the last completed draft, without its undo history. Autosave does not save the original, and abrupt exit, private browsing, storage limits or eviction can prevent recovery. **Restore previous version** lists local backups for the current document and offers workspace-only restoration or, for a connected file with permission, restoration to the original.

See the [save capability matrix](docs/SAVE-CAPABILITIES.md) for test boundaries and platform limits.

### Real-device checklist (not run)

Use disposable synthetic PDFs and check saved bytes by reopening, not just by reading the badge.

- [ ] **Chrome Android 132+**: check whether the picker is exposed on the actual build. If so, verify same-file saving, external-change choices and restoration; otherwise check copy and share.
- [ ] **iOS 26 Safari and Home Screen PWA**: verify copy-only messaging, the prepared PDF/Save to Files route, and that canceling the system share sheet leaves the edit unsaved.
- [ ] **Installed Chrome PWA**: verify a connected original with offline save and reopen, permission after relaunch, recovery, and restore of an older backup.

## Mobile behavior and limits

- At phone widths (768 CSS px and below), the filename truncates to one line. A single floating row combines page navigation and zoom. The status pill shows the page and save state over the viewer, then starts fading after about two seconds. **Pages** overlays thumbnails and page operations. **More tools** overlays theme, open, merge, extract and forms without resizing the viewer; closing returns focus to **More tools**.
- The bottom row holds **View**, **Text**, **Draw**, **Highlight**, **Image**, **Undo** and **Redo**. The mode strip may scroll internally; history remains directly tappable. Controls have a 44×44 CSS px minimum and inputs use at least 16 CSS px text. The dynamic viewport shell uses CSS safe-area insets, including bottom padding for the editing dock and More tools sheet.
- Choose **Text**, type a note in **Tool options**, dismiss the keyboard and tap where you want its baseline. Collapsing options preserves pending text. A successful placement (including **Place at page center**) clears the input; an empty repeat tap adds nothing. Scrolling, dragging, holding, canceling and multi-finger gestures do not place a note. **Undo** and **Redo** each take one tap.
- In **View**, a stationary tap hides or restores the controls; scrolling and pinching do not toggle them. In **View** or **Text**, drag to scroll or use two fingers to pan the zoomed page inside the viewer. Pinch zoom updates on release (50–300% of fit width); **Fit** restores full-width paper without horizontal scrolling. A tap after zoom and pan still places the note at the tapped baseline. In **Draw** and **Highlight**, a one-finger drag marks the page; switch to **View** to pan without marking.

Measured in Playwright WebKit 27.2 at initial Fit and scroll zero, with a synthetic three-page portrait Letter PDF. **Workspace** is the allocated viewer rectangle, including the area underneath the floating controls. The annotate gate is ≥75% of viewport height (80% target); immersive View must reach ≥92%. Persistent chrome is limited to 120 CSS px portrait and 88 CSS px landscape.

| Viewport (CSS px) | Annotate workspace: options closed / Text / Draw (px) | Annotate share (all three) | Immersive workspace | Header + toolbar | Floating nav | Status at 3 s |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| 390×664 | 576 / 576 / 576 | 86.7% | 664 (100%) | 44 + 44 | 50 | 0 |
| 375×812 | 724 / 724 / 724 | 89.2% | 812 (100%) | 44 + 44 | 50 | 0 |
| 390×844 | 756 / 756 / 756 | 89.6% | 844 (100%) | 44 + 44 | 50 | 0 |
| 430×932 | 844 / 844 / 844 | 90.6% | 932 (100%) | 44 + 44 | 50 | 0 |
| 320×568 | 480 / 480 / 480 | 84.5% | 568 (100%) | 44 + 44 | 50 | 0 |
| 664×390 | 302 / 302 / 302 | 77.4% | 390 (100%) | 44 + 44 | 50 | 0 |

**Paper intersection** is the rendered page clipped to viewport and workspace, before overlay occlusion; its width equals viewport width at Fit. **Occlusion** is the percentage of that clipped paper area covered by the union of overlay bounding boxes after status settles (a geometric estimate, not a pixel-opacity measurement). Height share is not the same as unoccluded paper area.

| Viewport | Paper height in annotate, all three states | Paper height in immersive | Paper occlusion: closed / Text / Draw / immersive |
| --- | ---: | ---: | ---: |
| 390×664 | 504.7 px | 504.7 px | 3.0% / 40.6% / 21.6% / 0% |
| 375×812 | 485.3 px | 485.3 px | 0% / 8.4% / 0% / 0% |
| 390×844 | 504.7 px | 504.7 px | 0% / 5.6% / 0% / 0% |
| 430×932 | 556.5 px | 556.5 px | 0% / 0% / 0% / 0% |
| 320×568 | 414.1 px | 414.1 px | 5.0% / 54.3% / 31.3% / 0% |
| 664×390 | 302 px | 390 px | 11.9% / 52.8% / 33.3% / 0% |

At Fit, root and stage scroll widths matched their client widths. The title occupied one line; measured controls were at least 44×44 px and displayed inputs were 16 px. Text, Draw and More tools leave the workspace rectangle unchanged. The suite captures these overlays, closed options, visible status and immersive View for each profile in `test-results/mobile/`; set `MOBILE_EVIDENCE_DIR` for a different output directory.

Each profile runs 50 touchscreen taps, 20 one-finger drags that must actually scroll the stage, and 10 alternating pinches that must change rendered width. Every step must leave zero notes, preserve pending text, and leave the outer page fixed. Separate checks cover one-shot placement, Undo/Redo (1 → 0 → 1 notes), cancellation, compatibility clicks, and two-finger pan. The note baseline after zoom and pan, and the ink centerline at Fit and after zoom and pan, are compared with gesture coordinates via the rendered SVG. All six profiles measured 0.0000 CSS px to four decimal places, against an 8 px limit.

WebKit delivers the touchscreen taps. The drag, scroll, pan, pinch and ink tests dispatch scripted touch pointers through the viewer and do not reproduce native iOS gesture physics.

### Emulated keyboard

At phone widths and browser scale 1, the editor follows `visualViewport.height` and `offsetTop` on resize and scroll. A clipped, focused option input scrolls into view inside the sheet. The sheet and dock stay above the reduced viewport even if focus leaves the input before keyboard dismissal. The PDF keeps its fit width and can still pan behind the sheet. On very short visual viewports, scroll the sheet to reach other controls.

The WebKit test keeps the Playwright and layout viewports at 390×664 CSS px. A test-only `visualViewport` shim changes only the visual height and offset; a hit-blocking overlay covers the simulated keyboard area. Measured control bounds are top–bottom in layout CSS px (rounded to two decimals):

| Sample | Visual height / top / bottom | Note | Size | Place |
| --- | ---: | ---: | ---: | ---: |
| Before | 664 / 0 / 664 | 395.02–439.02 | 443.81–487.81 | 492.61–536.61 |
| 300 px occlusion | 364 / 0 / 364 | 143.81–187.81 | 192.61–236.61 | 192.61–236.61 |
| Offset | 340 / 24 / 364 | 143.81–187.81 | 192.61–236.61 | 192.61–236.61 |
| Scroll event only | 340 / 36 / 376 | 155.81–199.81 | 204.61–248.61 | 204.61–248.61 |
| Restored | 664 / 0 / 664 | 395.02–439.02 | 443.81–487.81 | 492.61–536.61 |

All three controls passed hit-testing at these samples. The root stayed at (0, 0), browser scale at 1, and Fit paper width at 390 px. A separate pan check reached the lower edge of the Fit page without adding a note or losing draft text. The suite captures `webkit-390x664-keyboard-{before,open,offset,closed,pan}.png`.

**Emulation only:** these checks do not verify a real iOS keyboard, Safari toolbar movement, device safe-area inset values, or installation on an iPhone.

## Supported scope and limits

- Annotations are new page content, not edits to existing text, redaction, OCR, or cryptographic signatures. Added text and edited plain text fields use Helvetica’s Latin/WinAnsi character set. A highlight is a translucent freehand stroke, not text selection. The PDF canvas does not provide an accessible text layer or interactive PDF links; editing and navigation controls are keyboard accessible.
- Standard plain AcroForm fields stay editable in a standalone export without page removal. Deletion, merge and extract can rebuild the document: form appearances are flattened in that copy, and document-level data such as outlines, tags and attachments may not be preserved. Verify important output in your viewer. XFA, form scripts/calculations, rich text fields and signature fields are unsupported. Saving signed PDFs may invalidate existing signatures.
- Password-protected files require an unlocked copy. Corrupt files and unsupported PDF features can fail to open, render, or save. The page count is not a file-size limit; very image-heavy pages or large merges may still need significant memory. Browser cache eviction requires another online visit.
- PWA installation and file association depend on the browser and OS. The automated checks use Chromium and WebKit iPhone emulation; they do not simulate a native installation or OS file association.

## Verify

```sh
npm ci
npx playwright install chromium webkit
npm test
npm run test:save
npm run test:browser
npm run test:mobile
node --test --test-concurrency=1 tests/mobile.mjs
node scripts/assets.mjs --check
```

The Node suite checks immutable page operations, field updates, range extraction, annotation coordinates and undo/redo. The browser suite starts its own loopback server, generates PDFs, drives the editor, parses the downloaded PDFs, and checks rendered pixels. It covers denied downloads and exports of PDFs with inherited page attributes. If qpdf is installed, use `qpdf --check` on each `test-results/inherited-*.pdf` input and export for an additional structural check. For the offline scenario it stops the HTTP server and sets the Chromium context offline before reloading. Artifacts, including PDFs and screenshots, go to `test-results/` (ignored). `tests/fixtures/locked.pdf` is a synthetic one-page PDF encrypted with qpdf to exercise the password error; browser verification does not require qpdf.

## Phase 0 baseline

`npm run baseline -- --manifest tests/corpus/manifest.json --output <new-report.json> --timeout 8000` runs the unchanged editor in headless Chromium against local synthetic fixtures. Poppler `pdftoppm` supplies the independent content reference. See the [baseline methodology and run status](docs/baseline/README.md) for commands, timing definitions, reader validation and limitations. This measurement is not a production gate.

## Vendored software and offline assets

The [license and provenance policy](docs/CLEAN-ROOM.md) allows verified MIT, Apache-2.0, BSD-2-Clause, BSD-3-Clause and ISC dependencies. pdf-lib and PDF.js remain in use. We may read permissively licensed dependency source to understand behavior, debug or audit it, but we do not copy, translate or port third-party code into modules we write. GPL, AGPL and unknown licensing are barred. Each bundled file remains subject to independent license review; provenance and similarity checks also remain required.

- `vendor/pdfjs/`: Mozilla `pdfjs-dist` **6.5.438**, Apache-2.0. Unmodified browser and worker bundles, packed CMaps, standard fonts, ICC profile and WASM/decoder assets. Asset licenses are in their corresponding directories.
- `vendor/pdf-lib/`: `pdf-lib` **1.17.1**, MIT. Unmodified minified ES module and upstream license.

The exact files were extracted from the pinned npm distributions. They are used directly from disk by the browser. No packages are fetched at runtime. `npm run assets` regenerates the three actual PNG icons and the versioned service-worker asset list; rerun it after runtime changes. The app does not require regeneration to run from a checkout.

## License

Paperplane is licensed under the [MIT License](LICENSE). See [THIRD-PARTY-NOTICES](THIRD-PARTY-NOTICES) for third-party licenses and notices.
