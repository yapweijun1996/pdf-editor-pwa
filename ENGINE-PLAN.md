# Own-engine plan (owner decision, 2026-11-19)

The owner requires that this PDF editor be developed by us. We may study how other products behave and what the public specifications say. We must not copy their code. This file is the authority for the plan; the acceptance gates are in the owner-approved production criteria (kept with the AIC Console drafts and summarised in section 5).

## 1. Scope decision

- Phase 1 builds our own file layer: PDF parser, object model, cross-reference and object-stream handling, page tree and page operations, annotations, AcroForm fields, encryption handling, and a writer with incremental save.
- Rendering stays on the bundled third-party renderer behind one adapter interface in this phase. It is replaced only if the owner later decides so, after our file layer has passed the corpus gates.
- Until the file layer replaces pdf-lib, the README must state truthfully that pdf-lib and pdfjs are bundled third-party code.
- Out of scope for 1.x: editing existing text, redaction, OCR, cryptographic signatures, PDF/A or PDF/UA authoring, form design, collaboration, XFA.

## 2. Clean-room rules (mandatory)

1. Allowed sources: the public PDF specification text (ISO 32000-1 as freely published by Adobe, and ISO 32000-2 if the owner supplies it), public documentation, standards, and observed black-box behaviour of products (inputs and outputs only).
2. Forbidden: reading, copying, translating or porting source code of pdf.js, pdf-lib, MuPDF, PDFium, poppler, qpdf, pdfbox, iText or any other PDF implementation, including via search results, AI answers that quote code, or package internals. Bundled vendor files are not to be read for implementation ideas.
3. Two roles: the Research role writes behaviour notes from the specification (what must happen, with spec section numbers). The Implementation role writes code from those notes and the specification only.
4. Every module keeps a provenance record in `docs/provenance/`: module, specification sections used, notes used, author role, date. A reviewer who did not write the module checks it.
5. A similarity check against the bundled vendor sources runs before each release; a suspicious match means the module is rewritten by a different engineer.
6. Test oracles: we compare our results with other readers only through their outputs on corpus files.

## 3. Phases

- Phase 0 (current goal): clean-room policy files, provenance format, the sample corpus and its manifest, and a measurement harness that records baseline numbers for the current app. No change to editor behaviour.
- Phase 1a: behaviour notes for file structure, xref and object streams, incremental updates, the page tree, and the writer.
- Phase 1b: our parser and object model, read-only, checked against the whole corpus.
- Phase 1c: our writer and page operations, round-trip tested with independent readers.
- Phase 1d: annotations, AcroForm, encryption; remove pdf-lib when parity is shown on the corpus.
- Later: cross-browser and real-device runs, accessibility, performance, security review, release engineering.

## 4. Independence

The author of a change never signs its QA, provenance or security gate. QA keeps the blocker, minor and cosmetic classes; only blockers fail a round.

## 5. Production gates (summary)

Chromium, Firefox, WebKit and one real iPhone and Android phone; 50 and 500 page performance limits; at least 95 percent of the corpus opens, and saved files re-open in a second reader; WCAG 2.2 AA; no document content leaves the device; independent security review; versioned releases with rollback; LICENSE and notices.
