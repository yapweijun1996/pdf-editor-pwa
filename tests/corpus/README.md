# Phase 0 clean-room PDF corpus

Version **1.0.0** · goal `97e94b6a-60de-44e6-89d0-3b785f0b3a95`. This is synthetic test data for the unchanged editor, not a compatibility or performance claim. The [manifest](manifest.json) is the harness input and per-artifact source and rights ledger. Paths are relative to this directory. The 150 PDFs are [CC0-dedicated](CC0.md); generator, oracle driver and test code are [MIT](../../scripts/corpus/LICENSE).

| IDs | Count | Recipe groups (files per group) |
| --- | ---: | --- |
| SYN | 12 | Line endings (3), lexical variations (4), object layouts (2), contents layouts (3) |
| XRT | 10 | Contiguous tables (2), split tables (4), free/generation histories (4) |
| XRS | 10 | Field widths/defaults (3), index layouts (3), xref filters (2), hybrid updates (2) |
| OBJ | 8 | Single container (4), cross-container references (2), container filters (2) |
| INC | 10 | Marker replacement (2), page order/count (4), optional-object edits/deletion (4) |
| PAG | 16 | Tree depth/fanout (4), box and rotation overrides (4), resource inheritance (4), mixed geometry (4) |
| TXT | 14 | Standard fonts/encodings (4), original Type 3 glyph pairs (4), text state (4), ToUnicode mapping (2) |
| GFX | 12 | Clipped paths (2), transforms and device colors (4), blend/alpha (4), isolated soft masks (2) |
| IMG | 12 | Gray/RGB XObjects (4), inline/Flate (4), image masking (4) |
| ANN | 8 | Text notes (2), internal links (2), markup (2), appearances/flags (2) |
| FRM | 8 | Text fields (2), checkboxes (2), radio groups (2), list/dropdown (2) |
| MET | 6 | Info (2), catalog XML (2), component XML (2) |
| ENC | 10 | RC4 V1/R2 with password (4), AESV2 V4/R4 with password (4), restricted empty-user-password (2) |
| BAD | 10 | Bounded, recoverable defects (4), no usable page tree (6) |
| PER | 4 | Vector/text and image-heavier, each at 50 and 500 pages |

The [research matrix](../../docs/notes/phase0-fixtures.md) supplies the allocations; the engine plan does not. In XRT-03–06 the initial xref table uses one contiguous subsection per ISO 32000-1 §7.5.4; the appended revision has the split subsections and still covers every object number. The hybrid updates use an optional annotation hidden from table-only readers. SYN-03 uses CR delimiters except for the required LF after the `stream` keyword, which uses CRLF. BAD-01–04 each modify one aspect of SYN-01; shared page marks and similar bytes are deliberate, but all 150 whole-file SHA-256 hashes are distinct.

The performance pairs use the same fixed geometry and workload design at both scales. Every page has its own index, content stream and marker. The image workload adds two raster draws per page from a 12-image inherited pool (414,720 uncompressed RGB bytes per file; reused rather than replicated on hundreds of pages). The byte sizes in the manifest measure the actual serialized inputs, not memory or application timings.

## Reproduce and verify

Reference runtime: Node `26.13.0`, zlib `1.3.2.1-motley-456ae73`. Other zlib builds can emit different compressed bytes; use the reference build for exact reproduction. Recipe data, dates, IDs, and encryption IVs are fixed; no clock, network, editor runtime or PDF library is used by the generator. The synthetic credentials in the manifest are public. These intentionally legacy encryption profiles and deterministic IVs are never for real documents.

From the repository root:

```sh
scratch=$(mktemp -d)
node scripts/corpus/generate.mjs --output "$scratch"
node scripts/corpus/verify.mjs --compare "$scratch"
node --test tests/corpus/phase0-corpus-generation.test.mjs
node scripts/corpus/oracle.mjs --report "$scratch/oracle-report.json"
```

Omit `--compare` for checked-in integrity only. `--corpus <directory>` on the verifier and oracle selects another manifest directory. `node scripts/corpus/generate.mjs` regenerates the checked-in samples and manifest but does not change documentation, licenses or the oracle report.

## Harness and evidence

`expected` describes policy, not measured editor behavior. The 130 valid unencrypted files are success targets. Eight inputs require passwords; two have empty-user-password authorization but still carry restrictions. For these two, unsupported encryption or a successful authorized view is an observation, not a presumed edit capability. The four recoverable negatives can either fail cleanly or recover with the required marker. Do not probe export after rejection or work around a restriction. Six malformed inputs have no usable page tree and should fail cleanly. `standardsValid`, `intentionalInvalidity`, `preservation`, and the recipe parameters describe input-side expectations.

[Oracle results](oracle-report.json) are separate from the manifest. The author ran qpdf 12.4.2 and Poppler 25.04.0 (`pdfinfo`, `pdftotext`, `pdftoppm`) against the artifacts through public CLIs only. The checks cover syntax/stream decoding, page counts, ordered marker extraction, selected text and geometry, raster smoke checks, and credential controls. All four recoverable files were recovered with the expected content. qpdf rejected the six unusable inputs; for BAD-08, Poppler printed a page count from the invalid tree but diagnosed the null child, so the count alone is not evidence of a usable page. This report does not verify exact swatch colors, all metadata scopes, interactive features, app save/reopen, performance, or production readiness. Independent provenance and QA are separate gates.
