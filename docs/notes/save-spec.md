# Save specification mapping

For goal `6638c3e8-7b45-41da-ac7e-331670aece32` revision 3, the original S1–S4 and the internal save contract govern. This replaces the older copy-only rule only for a file explicitly opened through a connected picker handle. Input/drop and launch association remain copy-only. The contracted change does not authorize a push or require real-device owner acceptance.

- **S1:** A size/mtime/SHA-256 comparison identifies conflicts; overwrite uses the latest observed original bytes as backup. The transaction publishes metadata only after reading back the completed OPFS payload, then opens the target writer. It rereads the target for exact digest and PDF catalog/page-count validation and attempts rollback on failure. App-owned locks and rechecks are not an OS-level compare-and-swap.
- **S2:** Unconnected documents advertise copy mode. The separate prepared-PDF link is not a download link. The share control requires file-share capability and a second gesture; the user, not the app, confirms a saved copy.
- **S3:** The dirty guard and periodic OPFS snapshots are separate from saving the original. Recovery requires an explicit choice and restores materialized PDF content, not undo history. Versions and drafts use IndexedDB metadata and checked OPFS bytes; original permission is queried on recovery and requested on a save or restore gesture.
- **S4:** Existing Node, desktop and phone regression tests remain unchanged. Offline testing includes the new save module. The README lists, but does not claim, real-device checks.

The [save source ledger](save-sources.json) records the runtime author's specifications and consultation claims. The author described independent derivation using those API semantics and existing app/model/PDF interfaces, with no copied third-party implementation or new dependencies. The completion engineer adopted the five runtime files unchanged and authored the tests and documentation separately.
