# Independent save runtime provenance review

- Reviewer: `work-f6504733-70af-4b09-b69e-15f0304fa84a`, Save safety testing and scoped completion engineer, 2026-11-20 UTC. Dispatcher generation: `de285243-f5d4-4b63-8a96-87737fece3cc`.
- Source author: `work-976263da-3145-42fa-8116-eb43e05f2e81`, Data-safe original-file transaction and recovery architect, 2026-11-20 UTC. Author claims come from goal thread message 2; the retained proposal's historical outcome is unchanged.
- Base: `4b035fe8c0b13823aa1f3658146c65f3d2811c0b`. Retained source proposal: `62dadc163e25e6e5141356504a7b37d4c942d51a9377fb77ff18e0b601c7cf87`.

## Reviewed raw file fingerprints

| Path | SHA-256 |
| --- | --- |
| `src/save.js` | `a2cb65312ab8bf5c31889e9f0890f0f1da10ed2007b79ae994685700edfad6f6` |
| `src/app.js` | `90dfefefdd371293c81b6d695cbf9ecbfcfe862ac2686bc897fec5273ccc7b3b` |
| `index.html` | `8c39e202294743ed3059051b9778b72826014c37887d1b14d08b4cdd589f1659` |
| `style.css` | `1377d767b7211592a4d05fcf647d72b9b1d1e3e7ad28285044110f559611ddab` |
| `precache.js` | `a0aa975065e43494006ec2d0597cfedf4f4452e33514477947cf242bb14a61bc` |

The reviewer recomputed all five digests and compared the adopted bytes with the retained proposal. The reviewer contributed tests and documentation, not runtime changes. The source ledger maps the reported File System Standard writable semantics and Web Share activation to the implementation and lists the internal contract separately. Version and access-date claims for the two external references were transcribed, not independently observed or expanded. The save module uses the existing vendored PDF parser via its APIs and browser APIs; the scope adds no package or vendor changes. The adoption comparison, inspection of the code and author attestation support the independent derivation claim; this is not a general similarity scan or a proof of the author's browsing history.

## Verification boundary and verdict

Provenance **approved** for the exact five runtime fingerprints above. This is not standing QA, a release or security clearance, or owner approval. `tests/save.mjs` independently exercises the transaction, fallback, recovery and restore paths. Chromium tests use cloneable OPFS handles and intercepted picker/permission calls; temporary `.crswap` cleanup is demonstrated by a separate synthetic disk broker. WebKit covers browser fallback and a simulated installed-mode flag, not real iOS native storage, installation or share. The original-root static application graph is partial (unresolved dependencies); `src/save.js` is absent from the baseline and static graph data was not used as coverage evidence.
