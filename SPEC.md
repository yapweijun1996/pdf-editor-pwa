# PDF Editor PWA (owner request, 2026-11-18)

Build a browser-first, installable PWA PDF editor. Everything runs locally in the browser: no backend, no upload, no accounts. Plain HTML/CSS/JS ES modules, no build step if possible. Vendored libraries are allowed (pdf.js to render, pdf-lib to edit/save); vendor them into the repo with exact versions and licenses, so the app works offline. Do not load code from a CDN at runtime.

## Must have
- Open a PDF from the file picker, drag and drop, or the PWA file handler; render pages with zoom, page thumbnails and keyboard navigation.
- Edit and save a new PDF: add text, draw/highlight, add an image/signature, rotate, delete, reorder and extract pages, merge another PDF, fill plain form fields. Undo/redo.
- Download the edited PDF; the original file is never modified. Warn before closing with unsaved edits.
- Offline: service worker precaches every asset including vendored libraries; app works after the first load with the network off. Web app manifest with real PNG icons (192, 512, maskable).
- Responsive: usable on phone and desktop; touch and keyboard accessible; light and dark.
- Large file behaviour: a 50-page PDF stays responsive (lazy page rendering); clear error for corrupt or password-protected PDFs.
- English UI.

## Quality bar
- Node tests for pure logic (page operations, edit model, undo/redo) and a browser verification with a generated sample PDF: open, add text, rotate a page, delete a page, save, reopen the saved file and confirm the changes, then reload offline.
- QA classifies findings as blocker, minor or cosmetic; only blockers fail a round.
- README with how to run (static server), supported features and honest limitations.

## Models
Implementation employees use gpt-6.2-sol (the strongest allowed); lighter work (docs, icons, simple fixes) may use gpt-6-luna. Do not use other models.

## Delivery
After QA passes, push to the `origin` remote (`main`). This is a local bare repository; do not create or push to any GitHub repository.
