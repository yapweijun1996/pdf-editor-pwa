# Phase 0 third-party inventory

Start with the root [THIRD-PARTY-NOTICES](../../THIRD-PARTY-NOTICES). The [vendor inventory](inventory.json) is the per-file record; the [source ledger](sources.json) resolves evidence IDs. [Module provenance](../provenance/license-inventory.json) hashes this documentation snapshot and awaits independent review. None of these documents clears a release.

## What was checked

The inventory covers **207 vendor files**: two from `pdf-lib` (one bundle and one license file) and 205 from `pdfjs-dist` (192 payloads and 13 retained license/notice files). The PDF.js payloads are two main/worker bundles, 168 packed CMaps, one ICC profile, fourteen fonts and seven decoder/sandbox assets. Both official npm tarballs matched their registry SHA-512 integrity; each local file matched an exact tarball member. The 22 standalone font, ICC and decoder/sandbox payloads also matched the pinned Mozilla tree; the ICC profile matched its own upstream pinned revision. For all four Liberation fonts, the sfnt `name` table records 0, 5, 13 and 14 independently establish the copyright, version and license reference. The original 1.07.4 archive comparison was not obtained.

For embedded attribution, the official pdf-lib minified ESM source map is directly associated with the distributed ESM. The PDF.js npm distribution supplies source maps for the companion unminified browser and worker builds; these identify inputs and source notices, not a reproducible build of the minified files. Attribution checks were limited to release metadata, source maps, notice text and inputs needed for those mappings. No third-party implementation was copied into a project module. Official releases were fetched to scratch; no npm install was needed. Optional npm packages not included in the vendored selection (such as PDF.js's Node canvas integration) are outside the runtime inventory.

The owner's amended reading rule allows appropriate permissive source inspection for audit and bug understanding, not copying into project modules. Under plan §2, MIT, Apache-2.0, BSD-2/3-Clause and ISC are named acceptable when their text and notices are kept. The Liberation exception does not move GPL into that set. See `findings` for exact release-blocked and unverified paths. In particular, separately resolve CC0 policy for the ICC profile, the Adobe Core 14 converted-data conditions, the svgtopdf credit, and the decoder/worker build provenance. A byte-identical npm file can still have unresolved license, build-input or notice questions. External CLI versions and license evidence do not imply redistributing those tools, and no downloaded browser or external tool dependency audit was performed.

## Read the records

- `vendorFiles` is a sorted list with one record for every regular vendor file. `distribution`, `version`, `sourceUrl` and `member` identify the exact npm artifact and how to extract the member; `sha256` is for raw file bytes. `verifiedPinnedAssetUrl`, where present, is an additional byte match. `patchStatus` describes local differences from the official npm member only, not upstream changes relative to a precursor.
- Resolve every `components` ID to retrieve its license designations, component versions, notice paths, and source evidence. Multiple entries are concurrent attributions, not a choice of licenses. Companion license files have `kind: retained-license-notice`; their component points back to the governed payload, not a separate runtime dependency.
- `identified` means the listed attribution is evidenced, not release clearance. `unverified` keeps an unresolved provenance, terms or attribution question open; `needs-policy-review` distinguishes known terms from policy coverage; `blocked-for-release` records a known conflict. `NOASSERTION` is an explicit unknown, not a license pass. `LicenseRef-` labels refer to the retained text, not a claim of SPDX registration.
- `packages` records npm metadata and tarball hashes. `noticeSha256` hashes referenced retained notice bytes, including original vendor texts. `toolingNotShipped` deliberately separates locked dev packages, the local comparator, and external CLI test oracles.

## Supplemental notice origins

| Local artifact(s) | Exact reference |
| --- | --- |
| `brotli-LICENSE.txt` | `mozilla-brotli-license` in the source ledger |
| `base64-arraybuffer-LICENSE.txt`, `pdfkit-LICENSE.txt` | `base64-license` and `pdfkit-license`, respectively |
| `adobe-core14-MustRead.html` | `afm-notice` (identical to `afm-predecessor`); original Adobe notice retained byte-for-byte |
| `adobe-core14-notices.txt` | `Notice`, `FontName` and `Version` fields of the fourteen `package/es/*.compressed.json` metric members (zlib/Base64 JSON) of `standard-fonts` |
| `standard-fonts-LICENSE.md`, `upng-LICENSE.txt` | `package/LICENSE.md` and `package/LICENSE` of the corresponding npm archives |
| `pako-LICENSE.txt`, `pako-Zlib-notices.txt` | `package/LICENSE` (identical in both Pako releases) and Zlib notice headers in 1.0.11 `package/lib/zlib/` |
| `tslib-LICENSE.txt`, `tslib-CopyrightNotice.txt` | `package/LICENSE.txt`, `package/CopyrightNotice.txt` of tslib 1.11.1 |
| `playwright-*`, `playwright-core-*`, `typescript-*` | Exact version npm tarball `package/` members named by each local filename's suffix |
| `qpdf-LICENSE.txt`, `qpdf-NOTICE.md`, `poppler-COPYING.txt` | `qpdf-license`, `qpdf-notice`, and `poppler-release` (`poppler-25.04.0/COPYING`) |
| `attributions.txt` | Attribution-only transcription/summary with locators; no implementation included |

## Update and independently verify

1. Enumerate actual regular files under `vendor/` (report unexpected symlinks). Compare the sorted paths with `vendorFiles`; reject extras, omissions and duplicates. Hash raw bytes with SHA-256. Regroup counts by directory and compare all component, notice, source and findings references; a valid JSON parse alone is not sufficient.
2. In scratch, fetch each relevant exact version registry record and download its registered `.tgz`; compare SHA-512 SRI and SHA-256. Inspect members with `tar -tzf` and stream individual members with `tar -xOzf <archive> <member>` for byte comparison. Never extract over the project, run package scripts or install to perform this check. Compare the pinned asset URLs when available. Confirm the version with both package metadata and the actual member/header where applicable.
3. Recheck the source ledger, asset-specific terms and required notices for each changed version and ancestor. Verify inline attribution and data provenance, not only top-level package licenses. Do not mark missing evidence, GPL exceptions, or licenses outside the named list as approved. Update the exact paths in `findings` and the root notice summary. Changes to vendor/runtime files require a separate authorized task; this inventory procedure does not make them.
4. Recompute the baseline over `index.html`, `style.css`, `manifest.webmanifest`, `sw.js`, `precache.js`, `icons/`, `src/`, and `vendor/`. Compare the actual path set and byte identity against the baseline Git tree. The inventory digest is SHA-256 over a compact UTF-8 JSON array of lexically sorted `[path, sha256]` pairs, no trailing newline. At this revision the 219 assets match `bcfda7a`.
5. Refresh affected source entries, retained notices, and digests in the module provenance record; keep review pending until an independent reviewer validates the actual files and records a decision. Check the release packaging's notice delivery and outstanding findings separately from author verification or provenance review.
