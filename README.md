# Paperplane — Local PDF Studio

> **Beta.** Desktop editing is tested; mobile editing is being improved after a first real iPhone test (long tool panels, repeated text placement on tap). Treat the public demo as a test version.

Paperplane is a static, browser-first PDF editor. It reads files, renders pages, and generates new PDFs locally. There is no upload, no account, and no frontend build. Opened PDFs and edits are held in memory, not in the offline cache.

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
- **Fill forms** lists the plain fields from the PDF that supplied the selected page. Apply text, checkbox, radio, dropdown or list changes as one edit. Use **Undo**/**Redo** (up to 100 recent edits) or Ctrl/Cmd+Z and Ctrl/Cmd+Shift+Z. Ctrl/Cmd+S requests a download.
- **Download PDF** requests an `-edited.pdf` copy; the original is never written. The app cannot tell whether the browser saved, blocked, or canceled the download. Check that you have the file, then choose **I saved this copy** to mark that version as saved. Until you confirm, edited versions still trigger the replacement warning and request the browser’s standard unsaved-navigation warning. Later edits need a new download and confirmation. There is no crash/session restore, and some browsers do not show `beforeunload` prompts without prior interaction or when the OS terminates the app.

## Supported scope and limits

- Annotations are new page content, not edits to existing text, redaction, OCR, or cryptographic signatures. Added text and edited plain text fields use Helvetica’s Latin/WinAnsi character set. A highlight is a translucent freehand stroke, not text selection. The PDF canvas does not provide an accessible text layer or interactive PDF links; editing and navigation controls are keyboard accessible.
- Standard plain AcroForm fields stay editable in a standalone export without page removal. Deletion, merge and extract can rebuild the document: form appearances are flattened in that copy, and document-level data such as outlines, tags and attachments may not be preserved. Verify important output in your viewer. XFA, form scripts/calculations, rich text fields and signature fields are unsupported. Saving signed PDFs may invalidate existing signatures.
- Password-protected files require an unlocked copy. Corrupt files and unsupported PDF features can fail to open, render, or save. The page count is not a file-size limit; very image-heavy pages or large merges may still need significant memory. Browser cache eviction requires another online visit.
- PWA installation and file association depend on the browser and OS. The automated checks use desktop Chromium and a touch-emulated mobile viewport; they do not simulate a native installation or OS file association.

## Verify

```sh
npm ci
npx playwright install chromium
npm test
npm run test:browser
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
