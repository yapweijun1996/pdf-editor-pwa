# Independent save repair provenance review

- Reviewer: `work-8445e5f7-c0f6-4f93-8e6d-ae711cd9dc05`, Independent save repair regression and provenance review, 2026-11-20 UTC. Dispatcher generation: `2328c8d3-1217-4979-b711-e8e1cee507c0`.
- Repair author: `work-aee8ae75-3af8-4f85-bb71-a2a9e1e6ecb8`, PDF structural verification safety repair (`src/save.js`, `tests/save.mjs`, generated `precache.js`).
- Original runtime author: `work-976263da-3145-42fa-8116-eb43e05f2e81`, Data-safe original-file transaction and recovery architect. Prior tests and fixture: `work-f6504733-70af-4b09-b69e-15f0304fa84a`, Save safety testing and scoped completion engineer. The current reviewer wrote no runtime or permanent tests.
- Base: `ccbd98ebfe3a02f591a2217f64af249fa9185f1e`, tree `01ea8117261c3c8d58f1ba16f915b8daf6528a35`, identical to failed QA1 topic `fd50e3fca5fb76341cefeee90c63c0f282b350bd`. This does not attribute or approve the earlier ref movement.

## Provenance decision

Fresh provenance **approval** is limited to the seven raw SHA-256 fingerprints in [the revision record](../save.json). All seven were independently recomputed. The three changed fingerprints match the repair handoff; the other four files match the base. No vendor or dependency change is part of this repair. The previous provenance approval does not apply. The repair author reported no external PDF specification consultation or copied third-party source; implementation inspection found use of existing pdf-lib APIs. Historical public API consultations in the [source ledger](../../notes/save-sources.json) are attributed author reports, not independently witnessed browsing or a similarity audit. This decision is not standing QA, owner review, or release/security clearance.

## Independent regression evidence

A fresh Chromium probe generated a synthetic classic PDF and cut its intended export before xref, removing the table, trailer, `startxref` and EOF. pdf-lib still parsed one page. The base transaction opened one target writer after its backup, committed the truncated bytes and returned `saved`. With the repair, the public transaction rejected the export with a structure error before any target write; the original's SHA-256 was unchanged. A corrupted backup also caused zero target writes. Post-commit close rejection attempted abort and restored the original in a second write; truncated readback caused a hash mismatch and verified rollback. Both rollback probes retained two backups.

The permanent UI save matrix passed two valid multipage exports (classic xref and xref stream; hash, rotation, catalog, page count) and ten invalid intended exports: full xref/trailer truncation, absent EOF, absent `startxref`, out-of-range pointer, pointer to an ordinary object, absent trailer, absent Root, wrong Root, invalid table entry and wrong stream type. All ten preserved dirty state and the original digest with zero target writers. Code inspection confirmed a structural check before writing and again after the readback hash check. The checker is bounded to standalone output, not complete PDF conformance.

- Save: **33/33**, including fallback, conflict choices, injected aborts and restore, dirty navigation, OPFS recovery after renderer crash, and gesture-bound permission retry.
- Node: **18 passed, five opt-in skips, zero failures**. Desktop Chromium: **nine groups**, including server-stopped offline reload/edit/download. Asset check: **220**.
- WebKit mobile: **63/63 default**, **63/63 serial** across six profiles. The 390×664 viewer was 576 px (86.7%) with options closed; normal persistent chrome was 88 px. The existing keyboard, gesture and note/ink assertions passed unchanged.

The tests use synthetic data and real Chromium OPFS handles with intercepted pickers and permissions. The disk broker checks its own `.crswap` sibling, not native OS cleanup. WebKit simulates standalone mode and file sharing. Actual Safari/Firefox, devices, native OS pickers and share sheets, and exhaustive external-writer races were not verified. Static impact analysis was partial and was not used as coverage proof.
