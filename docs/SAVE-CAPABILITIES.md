# Save capability matrix

Paperplane checks for the picker at runtime. A browser name or version does not grant file access. Original-file saving requires a connected handle, write permission, browser locks, IndexedDB and a verified Origin Private File System (OPFS) backup. HTTPS or localhost is required for the secure-context APIs.

| Context | Save mode and fallback | Evidence and limits |
| --- | --- | --- |
| Chromium, picker available, file opened with **Open PDF** | **Overwrites the original**; **File options → Save a copy** remains available | Playwright intercepts the picker and returns a real Chromium OPFS handle. It checks native writes, structured clone and readback, not an OS picker or host-file permission dialog. |
| HTML file input, drop, or file association | **Saves a copy**, even on a browser that offers a picker | Desktop regression checks the original copy-only workflow; the incoming file does not bind a writable handle. |
| No picker: e.g. Firefox or Safari where the API is absent | **Saves a copy** with an explicit cannot-overwrite notice, a download, and **Open prepared PDF** | Headless Chromium and WebKit with pickers absent; Firefox and Apple Safari itself were not run. |
| File sharing available | Use **Share copy** on the prepared PDF; a separate click supplies fresh user activation | `canShare` and the share result are simulated; tests check the file and cancellation, not an OS share sheet. |
| Standalone iOS PWA | Where sharing works, use **Share copy**; otherwise **Open prepared PDF** provides a non-download-link path with Save to Files instructions | Standalone flag simulated in WebKit. Tests check the link and its bytes, not that iOS offers or completes Save to Files. |
| Chrome Android 132+ or installed Chrome PWA | Same capability checks; picker support is conditional; fallback remains copy mode | Unrun real-device checks in the [README](../README.md#real-device-checklist-not-run). |

Backups and drafts live in browser-managed storage for this origin; clear-site-data, eviction, private mode and storage limits can make them unavailable. Recovery opens the most recent successfully committed PDF rather than reconstructing the edit history. The browser may suppress navigation warnings or stop timers. Local autosave is not a disk save or a guarantee against loss.

Original-file writes recheck the fingerprint before committing; there is still a race with external writers because the browser API cannot atomically compare-and-swap arbitrary OS files. If rollback cannot be confirmed, do not assume the original is unchanged: inspect it and use the retained backup. The separate synthetic disk broker tests require cleanup of a real `.crswap` sibling on injected failures, but do not establish how the native OS picker implementation handles its temporary files.
