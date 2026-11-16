# Security

## Guarantees
- **No network:** CSP `connect-src 'none'`, `default-src 'none'`. The page cannot fetch, beacon, or load remote scripts, fonts, images or frames.
- **No storage:** no cookies, localStorage, sessionStorage or IndexedDB. Closing the tab erases everything.
- **No dependencies:** no npm packages, CDNs, build step or bundler. ~1,250 lines of plain JS to audit.
- **No code injection paths:** no `innerHTML`, `eval`, `Function`, or inline scripts/styles. All output goes to `textarea.value` / `textContent`, so pasted HTML is never rendered.
- **No forms:** `form-action 'none'`, `base-uri 'none'`.
- **Resource caps:** 25 MB input, 50 columns × 200,000 rows in the grid, undo history capped at ~60 MB. Large work runs in small time slices on the main thread (no Web Workers, so CSP stays `worker-src 'none'`).

## In-page indicators
- **Network locked:** listens for `securitypolicyviolation` events; any blocked attempt is counted and the indicator turns red.
- **Local code only:** checks every loaded resource (Resource Timing API) and flags any from another origin.
- **Wipe data:** clears the table, Markdown and undo history from memory.

## `serve.js` (optional)
- Binds to `127.0.0.1` only.
- Serves a fixed allowlist of 4 files; everything else is 404. No directory listing or path traversal.
- Sends CSP, `nosniff`, `no-referrer`, COOP/CORP, restrictive `Permissions-Policy`, `no-store`.

## Verify yourself
1. Open DevTools → Network, use the app: zero requests after page load.
2. Audit the source: `index.html`, `js/core.js`, `js/app.js`, `css/style.css`, `serve.js`.
3. `grep -nE "innerHTML|eval|Function\(|fetch|XMLHttpRequest|localStorage|WebSocket" js/` → only the header comment in `app.js`.
4. Pin a release: compare `sha256sum` of files against the release notes.

## Reporting
Open a private GitHub security advisory on this repo.
