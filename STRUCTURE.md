# STRUCTURE.md — UCSD EZPLAN

Chrome extension (Manifest V3) that adds a class search/planning interface on top of UCSD's TSS registration platform by passively capturing the user's TSS session and proxying TSS's SAP OData APIs.

## Entry points

- `manifest.json` — extension manifest; no build step, plain JS, no dependencies.
- `package-extension.ps1` — creates a ZIP from an explicit list of runtime files, excluding HAR captures and other workspace notes.
- `background.js` — MV3 service worker (`"type": "module"`), registered at manifest.json:13-16.
- `content.js` — content script injected on `https://tss.ucsd.edu/fiori*` (manifest.json:17-21).
- `reauth-content.js` — document-end content script on the tssproxy and A5 sign-in hosts (manifest.json:22-26); it stays inert unless the worker acknowledges the exact tab for an active custom re-auth flow.
  - Observes the DOM for the fresh UCSD SSO link, validates its proxy destination and flow parameters, and navigates once in the same tab using the complete live URL. On A5, it fills the named credential fields and clicks the `_eventId_proceed` submit button, preserving its form field and click handler. A document guard prevents duplicate helper runs.
  - The auth banner's Copy sign-in diagnostics button probes the active tab's helper through `getReauthDiagnostics`. Reports include the running extension revision, manifest registration, host access, flow stage, and helper handshake outcome; credentials, page contents, and URL query strings are excluded. A selectable report is available if clipboard access fails.
  - Before opening an Intercept tab or retaining credentials, the worker checks the loaded manifest's helper registration and granted access to both authentication hosts. Missing registration or access produces an actionable error instead of starting an unusable flow.
- `popup.html` — toolbar popup (`action.default_popup`, manifest.json:28-31); loads `popup.js` + `popup.css`; loads `theme-boot.js` in `<head>` before body to apply the saved theme without a flash. Also holds the shared re-auth controls and the topbar `#logout-btn` with its `#logout-dialog` confirmation.
- `planner.html` — side panel (`side_panel.default_path`, manifest.json:32-34) and full-tab planner opened via `chrome.tabs.create` (popup.js:1863); loads the same `popup.js`/`popup.css` and `theme-boot.js` in `<head>`.
- `theme-boot.js` — small async IIFE loaded in `<head>` of both popup.html and planner.html; reads `chrome.storage.local.get('theme')` and adds class `light-mode` to `document.documentElement` when the value is `'light'` (default dark); swallows storage errors and stays dark. Runs before body paint to avoid a flash of the wrong theme.
- `popup.js` boot: `DOMContentLoaded` handler (popup.js:1691) checks auth, loads storage, renders the reauth mode/theme, and auto-starts a full refresh when opened as `planner.html?refresh=all` (popup.js:1928).

## Layout

- Flat repo — all source files live at the root; no bundler, no `package.json`.
- `background.js` — API proxy + auth capture (runs only in the worker).
- `content.js` — term detection on TSS pages.
- `reauth-content.js` — inert-by-default sign-in automation helper (see Entry points).
- `popup.js` — all UI logic, shared by popup.html and planner.html.
- `theme-boot.js` — early theme-application IIFE (see Entry points); no exports.
- `popup.html` / `planner.html` — near-identical markup; body class `compact-view` vs `full-planner` selects layout via `isPlanner` (popup.js:8, set at popup.js:1853). Both load `theme-boot.js` in `<head>` and share the topbar `#reauth-mode-toggle`, `#theme-toggle`, and `#logout-btn`, auth-banner controls, the `#logout-dialog`, and the `#reauth-dialog` credential form.
- `popup.css` — all styling for both surfaces. Palette is defined as semantic design tokens: `:root` holds the dark (default) palette and `html.light-mode` overrides with light values; raw palette colors (mocha/steel/teal/pumpkin/powder) appear only in those two blocks and rules reference semantic tokens. Also styles `.topbar-right`, `.theme-toggle`, `.theme-toggle-knob` (knob shows `☾`/`☀`), `.reauth-mode-toggle`, `.auth-diagnostics`, and `.reauth-dialog`.
- `icon.png` — extension icon.
- `Outline_And_RE_Notes.md`, `notes.txt`, `*_request.txt`, `*_har_writeup.md` — design notes / sample API captures / HAR flow writeups; not loaded by code.

## Modules

### background.js
- `captureAuthHeaders` (background.js:50) — serialized by `authCaptureQueue` (background.js:39); merges new headers with previous and writes storage key `auth` only when changed or ≥5s since last write.
- Auth capture listener (background.js:113) — `chrome.webRequest.onBeforeSendHeaders` on `https://tss.ucsd.edu/sap/*` (background.js:124); extracts `cookie`, `sap-passport`, `x-csrf-token`, clearing old auxiliary headers when the cookie changes.
- Logout — `performTssLogout` opens the HAR-captured `https://tss.ucsd.edu/sap/public/bc/icf/logoff?sap-client=500` endpoint in a new tab, clears EZPLAN's captured `auth` and verification state, and suppresses auth recapture until a new Fiori landing is reported. The tssproxy page completes the SP/IdP logout flow; the A5 session may survive according to `logout_har_writeup.md`.
- Re-auth — official mode opens the SIS popup; custom (Intercept) mode starts a background tab at `CUSTOM_AUTH_START_URL` (background.js:8) and follows the same SAML flow. `startCustomReauth` preflights helper registration + host access, remembers the entered username in `chrome.storage.local`, and optionally keeps the password in `chrome.storage.session` key `savedCustomReauthPassword` until the browser session ends, EZPLAN reloads, or the user clears it. The active-flow credentials are stored separately under `customReauthCredentials` (`CUSTOM_CREDENTIALS_KEY`, background.js:10) for at most 2 minutes. The worker releases them once, only to a5.ucsd.edu on the flow's own tab. Phases: `automating` → `duo-opening` → `pending` → `verifying`, plus `failed` / `cancelled` / `connected`. The A5 helper fills and submits the credentials; Duo is surfaced in a true popup only when UCSD redirects there (`DUO_HOST`, background.js:9). The worker validates sender tab/host/stage and clears active-flow credentials on completion, cancel, failure, or timeout. `finishReauth` verifies a read-only OData response before closing the sign-in target.
- `getReauthDiagnostics` (background.js:1008) — fixed-shape report for the Copy sign-in diagnostics button: running revision, extension ID/version, helper registration, host permissions, flow phase/stage/host/error, tab host/status, and a helper probe. Never includes credentials, cookies, page contents, or URL query strings.
- Refresh-request lifecycle: `createRefreshRequest` / `cancelRefresh` / `finishRefresh` (background.js:72-108) — per-`refreshId` AbortControllers, 45s timeout (background.js:85), distinguishes `cancelled` vs `timeout` aborts.
- `searchClasses(term, query)` (background.js:746) — OData v4 `$batch` POST (multipart/mixed) against `MODULE_BASE`; parses via `parseBatchResponse` (background.js:715); dedupes by `ModuleID`; `$top=30`; on an outer or batch-part 403, fetches a fresh CSRF token and retries once; the fetch aborts after 25s (background.js:774).
- `getSections(moduleID, term, refreshId)` (background.js:825) — GET `YUCSD_CON_MODULE(...)/_sections`, `$top=1000`; validates all IDs are numeric.
- `getBookingDetails` (background.js:930) — wraps `fetchBookingDetails` (background.js:878) in `bookingRequestQueue`, enforcing ≥1200ms spacing between booking requests (background.js:932).
- `getRequirements(moduleID)` (background.js:951) — `$batch` GET `YUCSD_I_PREREQ_TREE(moduleid='<id>',keydate=YYYY-MM-DD)/Set`.
- Message router — handles `logoutTss` along with search, refresh, session-status, re-auth, and diagnostics messages. Logout and saved-credential controls accept requests only from extension pages. Credential requests and progress/error reports are accepted only from the active custom flow's own tab and an allowed host/stage.
- Error contract: API functions return `{ error }` with `no-auth` / `auth-expired` (auth status, redirect, or login HTML) / `http` / `network` / `parse` / `cancelled` / `timeout`; the UI keys off these strings. Custom re-auth details come from `CUSTOM_REAUTH_ERROR_DETAILS` (background.js:12): `helper-not-loaded`, `proxy-choice-not-found`, `a5-form-not-found`, `a5-form-not-recognized`, `a5-submit-failed`, `a5-login-not-accepted`, `credentials-unavailable`, `injection-failed`, `duo-window-failed`, `flow-timeout`, plus `background` / `credentials` / `window` / `helper-not-registered` / `host-access-missing` for startup failures.

### content.js
- `detectTerm` (content.js:8) — regexes page text for `Fall|Winter|Spring|Summer YYYY`, maps season → period code via `SEASON_MAP` (content.js:4), stores `chrome.storage.local` key `currentTerm`.
- On a real Fiori document, the content script sends `tssFioriReady` to the worker; it ignores the auto-submitting SAML form served at the same `/fiori` URL.
- Re-runs debounced (400ms) on load/hashchange/popstate/focus plus a `MutationObserver` on the whole document (content.js:28-42).

### popup.js (shared UI)
- `sendRuntimeMessage(message, timeoutMs = 20000)` (popup.js:18) — races `chrome.runtime.sendMessage` against a timeout so a hung worker surfaces an actionable error; `doSearch` uses 30s.
- Schedule parsing: `parseSched` (popup.js:101) — converts TSS `Sched` text lines into `{day,start,end,location,type}` blocks; final-exam lines get `isFinal: true` + `finalDate`.
- `groupSections` (popup.js:141) — groups raw section rows into section packages keyed by `EventPkgOtjid`, computing seats/waitlist/instructor/scheduleBlocks.
- `detectConflicts` (popup.js:179) — pairwise overlap on same-day regular blocks; finals conflict only when same date AND overlapping time.
- Rendering: `renderCalendar` (popup.js:291), `renderFinalCalendar` (popup.js:480, date-column grid), `renderPlannedList` (popup.js:612), `renderAll` (popup.js:726); lane layout via `assignOverlapLanes` (popup.js:242).
- Booking normalization: `normalizeBooking` (popup.js:804) maps raw booking events to UI shape; `enrichBookingRooms` (popup.js:774) matches dated meetings to parsed section blocks to fill in rooms.
- Refresh flows: `refreshClassInfo(classId)` (popup.js:974, single class, queued via `singleRefreshQueue`); `refreshAllClasses` (popup.js:1095, iterates all classes, caches section responses per `moduleID|year|period`); `stopClassRefresh` (popup.js:1215) sends `cancelRefresh`.
- Search: `doSearch` (popup.js:1342) with `normalizeSearchQuery` (popup.js:1335, e.g. `phys 2c` → `PHYS-002C`); result click → `getSections` → `openSectionPicker` (popup.js:1536) → writes a planned class.
- Prereqs: `parseRequirement` / `buildPrereqTree` / `renderPrereqTree` (popup.js:1404-1434); cached under storage key `req_<moduleID>` (popup.js:1456-1462).
- Auth banner: `showAuthBanner(mode, extra, strategy, reauthStep)` (popup.js:1237) renders `checking` / `automating` (step text keyed by `reauthStep`) / `duo-opening` / `pending` / `verifying` / `failed` / `cancelled` / `expired` / `not-connected`; `checkAuth` (popup.js:1661) maps `getSessionStatus` (`reauthPhase`, `reauthStrategy`, `reauthStep`, `background` error) to it and re-checks on storage changes and focus.
- Re-auth UI: `#reauth-mode-toggle` persists `chrome.storage.local.reauthUseOfficialPopup`; `#reauth-btn` retries an open flow, opens the official popup, or opens the centered `#reauth-dialog`; the Intercept form remembers the username and can use an optional session password. `#clear-saved-password-btn` clears that password when no re-auth flow is active. `#auth-diagnostics-btn` requests `getReauthDiagnostics` and copies or shows the report. The topbar `#logout-btn` opens `#logout-dialog`; only its red Logout button starts the logout flow, while No, Escape, and other dialog clicks dismiss it.
- Storage sync: `chrome.storage.onChanged` listeners re-check auth (popup.js:1711) and re-render on `plannedClasses` changes (popup.js:1893); `lastRefreshRun` is also how a second planner tab observes an in-flight refresh run (`observedRefreshId`, popup.js:992, 1104, 1910).
- Theme toggle: `#theme-toggle` click handler (popup.js:1864, near the `#open-planner` handler) toggles `light-mode` on `document.documentElement`, writes `chrome.storage.local.set({ theme: 'light'|'dark' })`, and updates `aria-checked`; a `chrome.storage.onChanged` listener for the `theme` key calls `syncThemeToggle()` to keep the switch in sync across popup/planner tabs; initial `syncThemeToggle()` runs at boot. `theme-boot.js` applies the saved class before paint so the toggle handler only manages later changes.

## Data flows

- Auth: the Re-auth button uses the selected official or custom strategy. Both follow TSS's SAML request through the UCSD proxy and A5; custom mode automates the chooser and credential form, then opens Duo only when the page requires user interaction. TSS request headers are captured into storage key `auth`; a separate OData GET must return the expected JSON before the UI shows Connected. The logout action navigates to SAP's `icf/logoff` route and clears EZPLAN's cached auth. Intercept credentials live only in `chrome.storage.session` for at most 2 minutes and are cleared after one claim, on completion/cancel/failure/timeout, or when the browser session ends.
- Term detection: content.js scrapes TSS page → storage `currentTerm` → popup badge (`termBadge`, popup.js:53); default `{ academicYear: '2026', academicPeriod: '2' }` (popup.js:2).
- Add a class: search → `searchClasses` → results → `getSections` → `groupSections` → section picker → planned-class record (schema built at popup.js:1620-1648, incl. `_lastPkg` raw cache) appended to storage `plannedClasses`.
- Refresh run: `refreshAllClasses` loops planned classes; per class calls `getSections` + `getBookingDetails`, merges via `updateStoredClass` (popup.js:827), and persists progress in storage `lastRefreshRun` (`{refreshId, startedAt, finishedAt, total, completed, errors, cancelled}`).
- Storage keys: `chrome.storage.local` holds `auth`, `currentTerm`, `plannedClasses`, `lastRefreshRun`, `req_<moduleID>`, `theme` (`'light'`/`'dark'`; default dark when absent), `reauthUseOfficialPopup` (boolean; default false = Intercept), and `reauthUsername`. `chrome.storage.session` holds `reauthFlow`, `authFault`, `tssLogoutPending`, the optional `savedCustomReauthPassword`, and transient `customReauthCredentials` (`{username, password, expiresAt}`, 2-minute lifetime).

## External dependencies & services

- Extension fetches target TSS (`https://tss.ucsd.edu`), a SAP Fiori app exposing OData APIs; official re-auth opens SIS and follows redirects through TSS proxy, UCSD, and Duo, while Intercept starts at TSS (`CUSTOM_AUTH_START_URL`, background.js:8) and automates the same proxy/A5 chain. OData requests use `sap-client=500`.
- `DUO_HOST` (background.js:9): `api-ce13a1a7.duosecurity.com`; a navigation here during `automating` opens the real Duo popup and moves the flow to `duo-opening`.
- `MODULE_BASE` (background.js:4): `https://tss.ucsd.edu/sap/opu/odata4/sap/yucsd_con_module_sb/srvd/sap/yucsd_con_module_servicedef/0001` — search, sections, prereqs.
- `BOOKING_BASE` (background.js:6): `https://tss.ucsd.edu/sap/opu/odata/ITUS/PR_MY_MODULES_V2_SRV` — booking state / dated event schedules (`ModuleHeaderSet(...)/Event?$expand=BookingCheckLog,Request,EventSchedule,CreditOptions`).
- Auth capture URL pattern: `https://tss.ucsd.edu/sap/*` (background.js:124).
- Deep link to TSS section page: `tssLink` (popup.js:367) — `https://tss.ucsd.edu/fiori#ZUSModule-display?...`.
- No third-party libraries; only `chrome.*` APIs and platform `Intl`/`fetch`.

## Configuration

- manifest.json permissions (manifest.json:6): `storage`, `webRequest`, `sidePanel`, `alarms`. Host permissions (manifest.json:7-12): `https://tss.ucsd.edu/*`, `https://tssproxy.ucsd.edu/*`, `https://a5.ucsd.edu/*`, `https://api-ce13a1a7.duosecurity.com/*`. Content scripts (manifest.json:17-27): `content.js` on `https://tss.ucsd.edu/fiori*`; `reauth-content.js` on tssproxy/A5 at `document_end`.
- Field selectors for API responses: `SEARCH_SELECT` (background.js:33) and `SECTION_SELECT` (background.js:35) — changing what the UI needs means editing these.
- Rate limits / timeouts: 1200ms min spacing between booking requests (background.js:932); 45s refresh-request abort timeout (background.js:85); 25s `searchClasses` fetch timeout (background.js:774); 2-minute custom re-auth alarm (`chrome.alarms`, background.js:11, 436); 30min staleness window for adopting an unfinished refresh run (popup.js:991, 1103).
- Term encoding: period codes `'1'` FA / `'2'` WI / `'3'` SP / `'4'` SU (`PERIOD_CODE` popup.js:3, `SEASON_MAP` content.js:4); zero-padded to 3 chars in API calls (background.js:752, 832).

## Gotchas

- `popup.js` serves both surfaces; behavior branches on `isPlanner` (body class `full-planner`), set at popup.js:1853.
- `popup.html` and `planner.html` duplicate their markup — DOM/ID changes must be mirrored in both files. This includes the shared `<head>` `<script src="theme-boot.js">` tag, the topbar controls, auth-banner controls, the `#logout-dialog`, and the `#reauth-dialog` credential form.
- MV3 service worker is ephemeral: in-memory state (`bookingRequestQueue`, `cancelledRefreshIds`, `refreshRequestControllers`, `customCredentialsClaimed`, `customDuoOpeningTabs`) resets when the worker sleeps; durable refresh state lives in `lastRefreshRun`, and custom-flow credentials live in `chrome.storage.session`.
- Single-flight refresh guards: `refreshAllClasses` refuses while `singleClassRefreshes` is non-empty and `refreshClassInfo` refuses during a full refresh (popup.js:979, 987, 1096-1097).
- Nothing works without a captured TSS session — every API call first checks `authPresent` (background.js:168) and returns `no-auth`.
- Planned-class records embed the raw section package in `_lastPkg` (stripped when writing `availablePackages`); `loadPlanned` (popup.js:34) rebuilds `scheduleBlocks` from it at load time, so changing the block shape requires touching both.
- Search results are capped at `$top=30` (background.js:757) and sections at `$top=1000` (background.js:836); there is no `$skip` pagination, so broad searches silently truncate — large result sets are not surfaced.
- `tssLink` (popup.js:367) emits `.../<moduleID>/00000000/0/0/0/00000000-0000-0000-0000-000000000000/<eventPkgObjid>/<year>/<period>/?`. The `00000000` int and all-zero GUID segments are not understood, but the link resolves correctly on TSS as-is — do not "clean up" or omit them without re-verifying.
- `x-csrf-token` lifetime is untested. Re-auth clears captured auxiliary headers when the TSS cookie changes, then verifies the new session. A search 403 forces a fresh token fetch and one retry in case the token expired while the TSS session remained valid.
- Intercept passwords are never written to `chrome.storage.local`: active-flow credentials live in `chrome.storage.session` (`customReauthCredentials`, 2-minute `expiresAt`), while the optional saved password uses a separate session key and is removed on browser-session end, extension reload, or by the clear button. Session storage is restricted to trusted extension contexts. The UI queries whether a saved password exists; the worker uses the stored password for the active A5 flow. The username is remembered in `chrome.storage.local`.
- `getReauthDiagnostics` emits only fixed fields (revision, IDs, helper registration, host permissions, flow stage, tab host/status, helper probe); credentials, cookies, page contents, and URL query strings are deliberately excluded.
- `sendRuntimeMessage` (popup.js:18) wraps `chrome.runtime.sendMessage` in a timeout race (20s default, 30s for search), so a stuck worker shows an actionable error instead of hanging the UI.
- Before starting Intercept, the worker checks the loaded manifest's helper registration and granted access to tssproxy/A5; missing registration, host access, or a start failure produces an actionable error instead of an unusable flow.
- Term→year mapping is unverified for Spring/Summer. `detectTerm` (content.js:8) uses the calendar year scraped from the page text verbatim as `academicYear`, with no year+1 adjustment. If TSS's OData API keys Spring/Summer to a different academic year, searches for those terms may return nothing.
- `getSessionStatus` actively checks a read-only TSS entity request. API calls also treat redirects and login HTML as expired auth; the Re-auth window opens only on a user click.
- The search `$filter` in `searchClasses` is `(AcademicYear eq '<year>' or AcademicYear eq '<year>')` — both branches of the `or` use the same year (background.js:754). This is almost certainly a leftover from the original TSS capture (which crossed two academic years for Spring/Summer); right now the `or` is a no-op. If the term→year gap above is fixed, this filter is where the second year would go.
- `showFinals` is a hardcoded `const ... = true` (popup.js:7) with no UI toggle and no `settings` storage key. The plan's `settings` schema (`showFinals`, `calendarStartHour`, `calendarEndHour`) was never implemented — calendar hours auto-fit from the data via `calendarLayout` (popup.js:227) instead. Adding a finals toggle or fixed hours means introducing the `settings` key and replacing the const.
- `searchClasses` sends a single search GET in the `$batch` body (background.js:746-772). The original TSS capture (see `Outline_And_RE_Notes.md`) batches two GETs — the search plus an exact-`ModuleID` lookup for a detail-view sidecar. That second GET was intentionally dropped here; if a detail sidecar is ever added, it would need its own batch part or a separate `getSections`-style call.
- The popup/planner split exists specifically to bypass Chrome's ~600px popup max height: `popup.html` is the compact toolbar view, `planner.html` is the side panel / full-tab view (`side_panel` in manifest.json:32, `chrome.tabs.create` at popup.js:1863). Both load the same `popup.js`, which branches on `isPlanner` (popup.js:1853).
