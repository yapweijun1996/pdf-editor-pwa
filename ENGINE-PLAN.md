# Engine and licensing plan (owner decision, updated 2026-11-19)

The owner requires that this PDF editor be developed by us, and that the result can be used commercially. Third-party open-source projects under the MIT license may be used. Other commercially usable permissive licenses (Apache-2.0, BSD, ISC) are treated the same way unless the owner objects. Copying code that is not under such a license is forbidden. This file is the authority for the plan; acceptance gates are summarised in section 5.

## 1. What "developed by us" means

- Our own work is the product: the application, features, user experience, quality gates, and every module we choose to write ourselves.
- We may depend on, bundle or vendor third-party libraries only when their license is MIT or another permissive, commercially usable license (section 2). Today: pdf-lib (MIT) and pdfjs-dist (Apache-2.0), both bundled unmodified.
- Where a module is ours, it is written by us from the specification and our own design, never pasted from another project.
- Whether to replace a library with our own module is decided per module by value and risk, not by default. The owner may ask for any module to be self-written; the first candidate is the file layer (parser, object model, writer, incremental save), because it is where control and correctness matter most.
- Out of scope for 1.x: editing existing text, redaction, OCR, cryptographic signatures, PDF/A or PDF/UA authoring, form design, collaboration, XFA.

## 2. License and provenance rules (mandatory)

1. Allowed to depend on or bundle: MIT, Apache-2.0, BSD-2/3-Clause, ISC. Each needs its license text and notice kept in the repository and listed in `THIRD-PARTY-NOTICES`.
2. Forbidden: GPL, AGPL, LGPL used in a way that imposes obligations on our code, source-available or non-commercial licenses, unlicensed code, and anything whose license cannot be verified. (MuPDF is AGPL and is therefore not allowed.)
3. No copying of code from any project into our own modules, including via search results or AI answers that quote code. Reading documentation and observing behaviour is fine. Reading permissively licensed source to understand a bug in a library we depend on is fine, but pasting it into our modules is not.
4. A module we write keeps a provenance record in `docs/provenance/`: module, specification sections and public documents used, author role, date. A reviewer who did not write the module checks it.
5. Before each release: license audit of every bundled file (name, version, license, source URL), checked by someone who did not add the dependency; a code-similarity check between our modules and the bundled third-party sources.
6. Third-party code stays unmodified where possible; any patch is documented.

## 3. Phases

- Phase 0 (current goal): license and provenance policy files, the sample corpus and its manifest, and a measurement harness that records baseline numbers for the current app. No change to editor behaviour.
- Phase 1: decide per module (file layer first) whether to write our own or keep the library, based on corpus results and measured gaps. Behaviour notes from the specification come before code.
- Then: correctness and performance on the corpus, cross-browser and real-device runs, accessibility, security review, release engineering.

## 4. Independence

The author of a change never signs its QA, provenance or security gate. QA keeps the blocker, minor and cosmetic classes; only blockers fail a round.

## 5. Production gates (summary)

Chromium, Firefox, WebKit and one real iPhone and Android phone; 50 and 500 page performance limits; at least 95 percent of the corpus opens, and saved files re-open in a second reader; WCAG 2.2 AA; no document content leaves the device; independent security review; versioned releases with rollback; LICENSE (MIT proposed) and third-party notices.
