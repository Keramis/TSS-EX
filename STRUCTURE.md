# STRUCTURE.md — UCSD EZPLAN

Chrome extension (Manifest V3) that adds a class search/planning interface on top of UCSD's TSS registration platform by passively capturing the user's TSS session and proxying TSS's SAP OData APIs.

## Entry points

- `manifest.json` — extension manifest; no build step, plain JS, no dependencies.
- `package-extension.ps1` — creates a ZIP from an explicit list of runtime files, excluding HAR captures and other workspace notes.
- `background.js` — MV3 service worker (`"type": "module"`), registered at manifest.json:8.
- `content.js` — content script injected on `https://tss.ucsd.edu/fiori*` (manifest.json:12-17).
- `popup.html` — toolbar popup (`action.default_popup`, manifest.json:18-21); loads `popup.js` + `popup.css`; loads `theme-boot.js` in `<head>` before body to apply the saved theme without a flash.
- `planner.html` — side panel (`side_panel.default_path`, manifest.json:22-24) and full-tab planner opened via `chrome.tabs.create` (popup.js:1639); loads the same `popup.js`/`popup.css` and `theme-boot.js` in `<head>`.
- `theme-boot.js` — small async IIFE loaded in `<head>` of both popup.html and planner.html; reads `chrome.storage.local.get('theme')` and adds class `light-mode` to `document.documentElement` when the value is `'light'` (default dark); swallows storage errors and stays dark. Runs before body paint to avoid a flash of the wrong theme.
- `popup.js` boot: `DOMContentLoaded` handler (popup.js:1618) checks auth, loads storage, renders, and auto-starts a full refresh when opened as `planner.html?refresh=all` (popup.js:1688).

## Layout

- Flat repo — all source files live at the root; no bundler, no `package.json`.
- `background.js` — API proxy + auth capture (runs only in the worker).
- `content.js` — term detection on TSS pages.
- `popup.js` — all UI logic, shared by popup.html and planner.html.
- `theme-boot.js` — early theme-application IIFE (see Entry points); no exports.
- `popup.html` / `planner.html` — near-identical markup; body class `compact-view` vs `full-planner` selects layout via `isPlanner` (popup.js:1629). Both load `theme-boot.js` in `<head>` and share a header theme-toggle button (`<div class="topbar-right"><button id="theme-toggle" class="theme-toggle" role="switch" ...><span class="theme-toggle-knob"></span></button>`).
- `popup.css` — all styling for both surfaces. Palette is defined as semantic design tokens: `:root` holds the dark (default) palette and `html.light-mode` overrides with light values; raw palette colors (mocha/steel/teal/pumpkin/powder) appear only in those two blocks and rules reference semantic tokens. Also styles `.topbar-right`, `.theme-toggle`, `.theme-toggle-knob` (knob shows `☾`/`☀`).
- `icon.png` — extension icon.
- `Outline_And_RE_Notes.md`, `notes.txt`, `*_request.txt` — design notes / sample API captures; not loaded by code.

## Modules

### background.js
- `captureAuthHeaders` (background.js:17) — serialized by `authCaptureQueue`; merges new headers with previous and writes storage key `auth` only when changed or ≥5s since last write.
- Auth capture listener — `chrome.webRequest.onBeforeSendHeaders` on `https://tss.ucsd.edu/sap/*`; extracts `cookie`, `sap-passport`, `x-csrf-token`, clearing old auxiliary headers when the cookie changes.
- Re-auth — `startReauth` opens or focuses a 600×800 Chrome popup at `https://sis.ucsd.edu/`, allowing SIS and TSS to create a fresh SAML request before UCSD sign-in and Duo. `finishReauth` waits for the TSS SAML callback or a real Fiori document, verifies a read-only OData response, fetches a fresh CSRF token when needed, then closes the window. Window ID, tab ID, flow phase, and the last API failure live in `chrome.storage.session`, without credentials.
- Refresh-request lifecycle: `createRefreshRequest` / `cancelRefresh` / `finishRefresh` (background.js:35-73) — per-`refreshId` AbortControllers, 45s timeout, distinguishes `cancelled` vs `timeout` aborts.
- `searchClasses(term, query)` (background.js:160) — OData v4 `$batch` POST (multipart/mixed) against `MODULE_BASE`; parses via `parseBatchResponse` (background.js:136); dedupes by `ModuleID`; `$top=30`.
- `getSections(moduleID, term, refreshId)` (background.js:234) — GET `YUCSD_CON_MODULE(...)/_sections`, `$top=1000`; validates all IDs are numeric.
- `getBookingDetails` (background.js:339) — wraps `fetchBookingDetails` (background.js:287) in `bookingRequestQueue`, enforcing ≥1200ms spacing between booking requests (background.js:342).
- `getRequirements(moduleID)` (background.js:360) — `$batch` GET `YUCSD_I_PREREQ_TREE(moduleid='<id>',keydate=YYYY-MM-DD)/Set`.
- Message router — handles `searchClasses`, `getSections`, `getBookingDetails`, `cancelRefresh`, `finishRefresh`, `getRequirements`, `getSessionStatus`, and `startReauth`.
- Error contract: API functions return `{ error }` with `no-auth` / `auth-expired` (auth status, redirect, or login HTML) / `http` / `network` / `parse` / `cancelled` / `timeout`; UI keys off these strings.

### content.js
- `detectTerm` (content.js:8) — regexes page text for `Fall|Winter|Spring|Summer YYYY`, maps season → period code via `SEASON_MAP` (content.js:4), stores `chrome.storage.local` key `currentTerm`.
- On a real Fiori document, the content script sends `tssFioriReady` to the worker; it ignores the auto-submitting SAML form served at the same `/fiori` URL.
- Re-runs debounced (400ms) on load/hashchange/popstate/focus plus a `MutationObserver` on the whole document (content.js:28-42).

### popup.js (shared UI)
- Schedule parsing: `parseSched` (popup.js:92) — converts TSS `Sched` text lines into `{day,start,end,location,type}` blocks; final-exam lines get `isFinal: true` + `finalDate`.
- `groupSections` (popup.js:132) — groups raw section rows into section packages keyed by `EventPkgOtjid`, computing seats/waitlist/instructor/scheduleBlocks.
- `detectConflicts` (popup.js:170) — pairwise overlap on same-day regular blocks; finals conflict only when same date AND overlapping time.
- Rendering: `renderCalendar` (popup.js:282), `renderFinalCalendar` (popup.js:471, date-column grid), `renderPlannedList` (popup.js:579), `renderAll` (popup.js:693); lane layout via `assignOverlapLanes` (popup.js:233).
- Booking normalization: `normalizeBooking` (popup.js:771) maps raw booking events to UI shape; `enrichBookingRooms` (popup.js:741) matches dated meetings to parsed section blocks to fill in rooms.
- Refresh flows: `refreshClassInfo(classId)` (popup.js:941, single class, queued via `singleRefreshQueue`); `refreshAllClasses` (popup.js:1062, iterates all classes, caches section responses per `moduleID|year|period`); `stopClassRefresh` (popup.js:1182) sends `cancelRefresh`.
- Search: `doSearch` (popup.js:1281) with `normalizeSearchQuery` (popup.js:1274, e.g. `phys 2c` → `PHYS-002C`); result click → `getSections` → `openSectionPicker` (popup.js:1475) → writes a planned class.
- Prereqs: `parseRequirement` / `buildPrereqTree` / `renderPrereqTree` (popup.js:1343-1392); cached under storage key `req_<moduleID>` (popup.js:1394-1403).
- Storage sync: `chrome.storage.onChanged` listeners re-check auth (popup.js:1619) and re-render on `plannedClasses` / `currentTerm` / `lastRefreshRun` changes (popup.js:1653); `lastRefreshRun` is also how a second planner tab observes an in-flight refresh run (`observedRefreshId`, popup.js:958-971, 1070-1083).
- Theme toggle: `#theme-toggle` click handler (popup.js:~1640, near the `#open-planner` handler) toggles `light-mode` on `document.documentElement`, writes `chrome.storage.local.set({ theme: 'light'|'dark' })`, and updates `aria-checked`; a `chrome.storage.onChanged` listener for the `theme` key calls `syncThemeToggle()` to keep the switch in sync across popup/planner tabs; initial `syncThemeToggle()` runs at boot. `theme-boot.js` applies the saved class before paint so the toggle handler only manages later changes.

## Data flows

- Auth: the Re-auth button in either extension view opens SIS, which redirects through TSS's SAML request page to UCSD sign-in and Duo. TSS request headers are captured into storage key `auth`; a separate OData GET must return the expected JSON before the UI shows Connected. An API failure remains visible across tab focus changes until re-auth or that same API operation succeeds.
- Term detection: content.js scrapes TSS page → storage `currentTerm` → popup badge (`termBadge`, popup.js:44); default `{ academicYear: '2026', academicPeriod: '2' }` (popup.js:2).
- Add a class: search → `searchClasses` → results → `getSections` → `groupSections` → section picker → planned-class record (schema built at popup.js:1559-1587, incl. `_lastPkg` raw cache) appended to storage `plannedClasses`.
- Refresh run: `refreshAllClasses` loops planned classes; per class calls `getSections` + `getBookingDetails`, merges via `updateStoredClass` (popup.js:794), and persists progress in storage `lastRefreshRun` (`{refreshId, startedAt, finishedAt, total, completed, errors, cancelled}`).
- Storage keys: `chrome.storage.local` holds `auth`, `currentTerm`, `plannedClasses`, `lastRefreshRun`, `req_<moduleID>`, and `theme` (`'light'`/`'dark'`; default dark when absent). `chrome.storage.session` holds `reauthFlow` window/tab IDs and status plus `authFault` operation/error/timestamp, without credentials.

## External dependencies & services

- Extension fetches target TSS (`https://tss.ucsd.edu`), a SAP Fiori app exposing OData APIs; the separate sign-in window begins at SIS and follows redirects through TSS proxy, UCSD, and Duo. OData requests use `sap-client=500`.
- `MODULE_BASE` (background.js:4): `https://tss.ucsd.edu/sap/opu/odata4/sap/yucsd_con_module_sb/srvd/sap/yucsd_con_module_servicedef/0001` — search, sections, prereqs.
- `BOOKING_BASE` (background.js:6): `https://tss.ucsd.edu/sap/opu/odata/ITUS/PR_MY_MODULES_V2_SRV` — booking state / dated event schedules (`ModuleHeaderSet(...)/Event?$expand=BookingCheckLog,Request,EventSchedule,CreditOptions`).
- Auth capture URL pattern: `https://tss.ucsd.edu/sap/*` (background.js:87).
- Deep link to TSS section page: `tssLink` (popup.js:358) — `https://tss.ucsd.edu/fiori#ZUSModule-display?...`.
- No third-party libraries; only `chrome.*` APIs and platform `Intl`/`fetch`.

## Configuration

- manifest.json permissions: `storage`, `webRequest`, `sidePanel`; host permissions `https://tss.ucsd.edu/*`; content script match `https://tss.ucsd.edu/fiori*`.
- Field selectors for API responses: `SEARCH_SELECT` (background.js:7) and `SECTION_SELECT` (background.js:9) — changing what the UI needs means editing these.
- Rate limits / timeouts: 1200ms min spacing between booking requests (background.js:342); 45s per-request abort timeout (background.js:45); 30min staleness window for adopting an unfinished refresh run (popup.js:958, 1070).
- Term encoding: period codes `'1'` FA / `'2'` WI / `'3'` SP / `'4'` SU (`PERIOD_CODE` popup.js:3, `SEASON_MAP` content.js:4); zero-padded to 3 chars in API calls (background.js:166, 241).

## Gotchas

- `popup.js` serves both surfaces; behavior branches on `isPlanner` (body class `full-planner`), set at popup.js:1629.
- `popup.html` and `planner.html` duplicate their markup — DOM/ID changes must be mirrored in both files. This now includes the shared `<div class="topbar-right">` + `#theme-toggle` header button and the `<head>` `<script src="theme-boot.js">` tag.
- MV3 service worker is ephemeral: in-memory state (`bookingRequestQueue`, `cancelledRefreshIds`, `refreshRequestControllers`) resets when the worker sleeps; durable refresh state lives in `lastRefreshRun`.
- Single-flight refresh guards: `refreshAllClasses` refuses while `singleClassRefreshes` is non-empty and vice versa (popup.js:946-949, 1063-1067).
- Nothing works without a captured TSS session — every API call first checks `authPresent` (background.js:101) and returns `no-auth`.
- Planned-class records embed the raw section package in `_lastPkg` (stripped when writing `availablePackages`); `loadPlanned` (popup.js:25) rebuilds `scheduleBlocks` from it at load time, so changing the block shape requires touching both.
- Search results are capped at `$top=30` (background.js:171) and sections at `$top=1000` (background.js:245); there is no `$skip` pagination, so broad searches silently truncate — large result sets are not surfaced.
- `tssLink` (popup.js:358) emits `.../<moduleID>/00000000/0/0/0/00000000-0000-0000-0000-000000000000/<eventPkgObjid>/<year>/<period>/?`. The `00000000` int and all-zero GUID segments are not understood, but the link resolves correctly on TSS as-is — do not "clean up" or omit them without re-verifying.
- `x-csrf-token` lifetime is untested. Re-auth clears captured auxiliary headers when the TSS cookie changes, then verifies the new session.
- Term→year mapping is unverified for Spring/Summer. `detectTerm` (content.js:8) uses the calendar year scraped from the page text verbatim as `academicYear`, with no year+1 adjustment. If TSS's OData API keys Spring/Summer to a different academic year, searches for those terms may return nothing.
- `getSessionStatus` actively checks a read-only TSS entity request. API calls also treat redirects and login HTML as expired auth; the Re-auth window opens only on a user click.
- The search `$filter` in `searchClasses` is `(AcademicYear eq '<year>' or AcademicYear eq '<year>')` — both branches of the `or` use the same year (background.js:168). This is almost certainly a leftover from the original TSS capture (which crossed two academic years for Spring/Summer); right now the `or` is a no-op. If the term→year gap above is fixed, this filter is where the second year would go.
- `showFinals` is a hardcoded `const ... = true` (popup.js:7) with no UI toggle and no `settings` storage key. The plan's `settings` schema (`showFinals`, `calendarStartHour`, `calendarEndHour`) was never implemented — calendar hours auto-fit from the data via `calendarLayout` (popup.js:218) instead. Adding a finals toggle or fixed hours means introducing the `settings` key and replacing the const.
- `searchClasses` sends a single search GET in the `$batch` body (background.js:160-184). The original TSS capture (see `Outline_And_RE_Notes.md`) batches two GETs — the search plus an exact-`ModuleID` lookup for a detail-view sidecar. That second GET was intentionally dropped here; if a detail sidecar is ever added, it would need its own batch part or a separate `getSections`-style call.
- The popup/planner split exists specifically to bypass Chrome's ~600px popup max height: `popup.html` is the compact toolbar view, `planner.html` is the side panel / full-tab view (`side_panel` in manifest.json:22, `chrome.tabs.create` at popup.js:1639). Both load the same `popup.js`, which branches on `isPlanner` (popup.js:1629).
