// Service worker: passively captures auth headers from TSS requests and
// proxies class-search / section-detail API calls on behalf of the popup.

const MODULE_BASE =
  'https://tss.ucsd.edu/sap/opu/odata4/sap/yucsd_con_module_sb/srvd/sap/yucsd_con_module_servicedef/0001';
const BOOKING_BASE = 'https://tss.ucsd.edu/sap/opu/odata/ITUS/PR_MY_MODULES_V2_SRV';
const AUTH_START_URL = 'https://sis.ucsd.edu/';
const CSRF_URL = `${MODULE_BASE}/$metadata?sap-client=500`;
const AUTH_VERIFY_URL = `${MODULE_BASE}/YUCSD_CON_MODULE?sap-client=500&$select=ModuleID&$top=1`;
const TSS_SESSION_CACHE_KEY = 'tssSessionVerification';
const TSS_SESSION_SUCCESS_TTL = 5 * 60 * 1000;
const TSS_SESSION_FAILURE_TTL = 10 * 1000;
const SEARCH_SELECT =
  'AcademicLevel,AcademicPeriod,AcademicYear,CourseAbbr,CourseTitle,CreditsDisplay,DepartmentAbbr,DepartmentText,ModuleID,incrementDisplay';
const SECTION_SELECT =
  'AcPeriod,AcYear,EventAbbr,EventID,EventPkgDisable,EventPkgDisplayID,EventPkgLimit,EventPkgNumOnWaitl,EventPkgObjid,EventPkgOtjid,EventPkgSeatsAvailable,EventPkgSemanticColorCapacity,EventPkgStatusText,EventPkgText,InstructorEmail,InstructorName,ModuleID,Sched,Status,StatusSemantic,TeachingMethod,TeachingMethod_Text,locationText';
let bookingRequestQueue = Promise.resolve();
let lastBookingRequestAt = 0;
let authCaptureQueue = Promise.resolve();
let sessionVerificationPromise = null;
let reauthStartPromise = null;
let reauthLandingAgain = false;
let reauthFinalDocumentSeen = false;
const refreshRequestControllers = new Map();
const cancelledRefreshIds = new Set();

function captureAuthHeaders(headers) {
  authCaptureQueue = authCaptureQueue.then(async () => {
    const { auth: previous } = await chrome.storage.local.get('auth');
    const now = Date.now();
    const cookieChanged = Boolean(headers.cookie && headers.cookie !== previous?.cookie);
    const next = {
      cookie: headers.cookie || previous?.cookie || null,
      sapPassport: cookieChanged ? null : headers.sapPassport || previous?.sapPassport || null,
      csrfToken: cookieChanged ? null : headers.csrfToken || previous?.csrfToken || null,
    };
    if (cookieChanged && !(await getCachedTssSessionVerification())?.connected) {
      await chrome.storage.session.remove(TSS_SESSION_CACHE_KEY).catch(() => undefined);
    }
    const changed = next.cookie !== (previous?.cookie || null)
      || next.sapPassport !== (previous?.sapPassport || null)
      || next.csrfToken !== (previous?.csrfToken || null);
    if (changed || now - (previous?.capturedAt || 0) >= 5000) {
      await chrome.storage.local.set({ auth: { ...next, capturedAt: now } });
    }
  }).catch(() => undefined);
}

function createRefreshRequest(refreshId) {
  if (!refreshId) return { signal: undefined, result: () => 'network', finish: () => {} };
  const controller = new AbortController();
  const requests = refreshRequestControllers.get(refreshId) || new Set();
  requests.add(controller);
  refreshRequestControllers.set(refreshId, requests);
  if (cancelledRefreshIds.has(refreshId)) {
    controller.userCancelled = true;
    controller.abort();
  }
  const timeoutId = setTimeout(() => {
    controller.timedOut = true;
    controller.abort();
  }, 45000);
  return {
    signal: controller.signal,
    result: () => controller.userCancelled ? 'cancelled' : controller.timedOut ? 'timeout' : 'network',
    finish: () => {
      clearTimeout(timeoutId);
      requests.delete(controller);
      if (!requests.size) refreshRequestControllers.delete(refreshId);
    },
  };
}

function cancelRefresh(refreshId) {
  if (!refreshId) return false;
  cancelledRefreshIds.add(refreshId);
  const requests = refreshRequestControllers.get(refreshId);
  for (const controller of requests || []) {
    controller.userCancelled = true;
    controller.abort();
  }
  return true;
}

function finishRefresh(refreshId) {
  if (refreshId) cancelledRefreshIds.delete(refreshId);
}

// ----- Passive auth capture -----
chrome.webRequest.onBeforeSendHeaders.addListener(
  (details) => {
    const headers = {};
    for (const h of details.requestHeaders) {
      const n = h.name.toLowerCase();
      if (n === 'cookie') headers.cookie = h.value;
      else if (n === 'sap-passport') headers.sapPassport = h.value;
      else if (n === 'x-csrf-token' && h.value && h.value.toLowerCase() !== 'fetch') headers.csrfToken = h.value;
    }
    if (headers.cookie || headers.sapPassport || headers.csrfToken) captureAuthHeaders(headers);
  },
  { urls: ['https://tss.ucsd.edu/sap/*'] },
  ['requestHeaders', 'extraHeaders']
);

async function getAuth() {
  const { auth } = await chrome.storage.local.get('auth');
  return auth;
}

async function getSessionStatus() {
  const auth = await getAuth();
  const flow = await getReauthFlow();
  if (flow?.phase === 'pending' || flow?.phase === 'verifying') {
    return { connected: false, capturedAt: auth?.capturedAt || null, reauthPhase: flow.phase };
  }
  const reauthError = flow?.phase === 'failed' ? (flow.detail || flow.error || null) : null;
  const fault = await getAuthFault();
  if (fault) {
    return {
      connected: false,
      capturedAt: auth?.capturedAt || null,
      reauthPhase: flow?.phase || null,
      reauthError,
      error: fault.error,
    };
  }
  const verification = await verifyTssSession();
  return {
    connected: verification.connected,
    capturedAt: (await getAuth())?.capturedAt || null,
    reauthPhase: verification.connected ? 'connected' : flow?.phase || null,
    reauthError,
    error: verification.error || null,
  };
}

function authPresent(auth) {
  return auth && (auth.cookie || auth.csrfToken || auth.sapPassport);
}

function optionalAuthHeaders(auth) {
  return {
    ...(auth.sapPassport ? { 'sap-passport': auth.sapPassport } : {}),
    ...(auth.csrfToken ? { 'x-csrf-token': auth.csrfToken } : {}),
  };
}

function isAuthResponse(resp) {
  if (resp.type === 'opaqueredirect' || [301, 302, 303, 307, 308, 401, 403].includes(resp.status)) return true;
  if (!resp.ok) return false;
  try {
    if (new URL(resp.url).origin !== 'https://tss.ucsd.edu') return true;
  } catch {
    return true;
  }
  return /text\/html/i.test(resp.headers.get('content-type') || '');
}

async function ensureCsrfToken(force = false) {
  try {
    const existing = await getAuth();
    if (existing?.csrfToken && !force) return;
    if (existing?.csrfToken && force) {
      await chrome.storage.local.set({ auth: { ...existing, csrfToken: null } });
    }
  } catch {
    return;
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10000);
  try {
    const resp = await fetch(CSRF_URL, {
      headers: { 'x-csrf-token': 'Fetch' },
      credentials: 'include',
      redirect: 'manual',
      signal: controller.signal,
    });
    if (isAuthResponse(resp) || !resp.ok) return;
    const token = resp.headers.get('x-csrf-token');
    if (!token || /^(fetch|required)$/i.test(token)) return;
    await authCaptureQueue;
    const auth = await getAuth();
    await chrome.storage.local.set({ auth: { ...(auth || {}), csrfToken: token, capturedAt: Date.now() } });
  } catch {
    // Read-only API calls can still work if this service does not issue a token.
  } finally {
    clearTimeout(timeout);
  }
}

async function getCachedTssSessionVerification() {
  try {
    const { [TSS_SESSION_CACHE_KEY]: cached } = await chrome.storage.session.get(TSS_SESSION_CACHE_KEY);
    if (!cached || !Number.isFinite(cached.checkedAt) || !cached.result) return null;
    const ttl = cached.result.connected ? TSS_SESSION_SUCCESS_TTL : TSS_SESSION_FAILURE_TTL;
    return Date.now() - cached.checkedAt < ttl ? cached.result : null;
  } catch {
    return null;
  }
}

async function cacheTssSessionVerification(result) {
  try {
    await chrome.storage.session.set({
      [TSS_SESSION_CACHE_KEY]: { checkedAt: Date.now(), result },
    });
  } catch {
    // Session status can still be returned if the short-lived cache is unavailable.
  }
}

async function verifyTssSession(force = false) {
  if (!force) {
    const cached = await getCachedTssSessionVerification();
    if (cached) return cached;
  }
  if (sessionVerificationPromise) return sessionVerificationPromise;
  const verificationPromise = (async () => {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15000);
    try {
      const resp = await fetch(AUTH_VERIFY_URL, {
        headers: { Accept: 'application/json' },
        credentials: 'include',
        redirect: 'manual',
        signal: controller.signal,
      });
      if (isAuthResponse(resp) || !resp.ok || !/application\/json/i.test(resp.headers.get('content-type') || '')) {
        return { connected: false, error: 'auth-expired' };
      }
      const data = await resp.json();
      if (!Array.isArray(data?.value)) return { connected: false, error: 'invalid-response' };
      await authCaptureQueue;
      ensureCsrfToken().catch(() => undefined);
      return { connected: true, error: null };
    } catch {
      return { connected: false, error: 'network' };
    } finally {
      clearTimeout(timeout);
    }
  })();
  sessionVerificationPromise = verificationPromise;
  try {
    const result = await verificationPromise;
    await cacheTssSessionVerification(result);
    return result;
  } finally {
    if (sessionVerificationPromise === verificationPromise) sessionVerificationPromise = null;
  }
}

async function getReauthFlow() {
  const { reauthFlow } = await chrome.storage.session.get('reauthFlow');
  return reauthFlow || null;
}

async function getAuthFault() {
  const { authFault } = await chrome.storage.session.get('authFault');
  return authFault || null;
}

async function clearAuthFault() {
  await chrome.storage.session.remove('authFault');
}

async function trackApiResult(operation, request) {
  const startedAt = Date.now();
  let result;
  try {
    result = await request;
  } catch {
    result = { error: 'network' };
  }
  try {
    if (['no-auth', 'auth-expired', 'network', 'parse', 'http'].includes(result?.error)) {
      await chrome.storage.session.set({ authFault: { operation, error: result.error, at: Date.now() } });
    } else if (!result?.error) {
      const fault = await getAuthFault();
      if (fault?.operation === operation && fault.at <= startedAt) await clearAuthFault();
    }
  } catch {
    // Session-state reporting must not prevent the API result from reaching the UI.
  }
  return result;
}

async function setReauthFlow(flow) {
  await chrome.storage.session.set({ reauthFlow: flow });
}

function getReauthErrorDetail(error) {
  const detail = String(error?.message || error || 'Unknown browser error')
    .replace(/[\r\n]+/g, ' ')
    .trim();
  return detail.slice(0, 180) || 'Unknown browser error';
}

async function startReauth() {
  if (reauthStartPromise) return reauthStartPromise;
  reauthStartPromise = (async () => {
    let windowId = null;
    try {
      const previous = await getReauthFlow();
      if (Number.isInteger(previous?.windowId) && Number.isInteger(previous?.tabId)) {
        if (['pending', 'verifying'].includes(previous.phase)) {
          try {
            await chrome.tabs.get(previous.tabId);
            await chrome.windows.get(previous.windowId);
            await chrome.windows.update(previous.windowId, { focused: true });
            return { phase: previous.phase };
          } catch {
            await chrome.windows.remove(previous.windowId).catch(() => undefined);
          }
        } else {
          await chrome.windows.remove(previous.windowId).catch(() => undefined);
        }
      }
      reauthLandingAgain = false;
      reauthFinalDocumentSeen = false;
      await chrome.storage.session.remove(TSS_SESSION_CACHE_KEY).catch(() => undefined);
      await setReauthFlow({ phase: 'pending', sawAcs: false, startedAt: Date.now() });
      const loginWindow = await chrome.windows.create({
        url: 'about:blank', type: 'popup', width: 600, height: 800, focused: true,
      });
      windowId = loginWindow?.id;
      if (!Number.isInteger(windowId)) throw new Error('Sign-in window did not open');
      const [tab] = await chrome.tabs.query({ windowId });
      if (!Number.isInteger(tab?.id)) throw new Error('Sign-in tab did not open');
      await setReauthFlow({ phase: 'pending', windowId, tabId: tab.id, sawAcs: false, startedAt: Date.now() });
      await chrome.tabs.update(tab.id, { url: AUTH_START_URL });
      return { phase: 'pending' };
    } catch (error) {
      const detail = getReauthErrorDetail(error);
      console.error('Re-auth could not open the sign-in window:', detail);
      if (windowId !== null) await chrome.windows.remove(windowId).catch(() => undefined);
      await setReauthFlow({ phase: 'failed', error: 'window', detail }).catch(() => undefined);
      return { phase: 'failed', error: 'window', detail };
    }
  })();
  try {
    return await reauthStartPromise;
  } finally {
    reauthStartPromise = null;
  }
}

async function finishReauth(tabId, finalDocument = false) {
  const flow = await getReauthFlow();
  if (flow?.tabId !== tabId) return;
  if (flow.phase === 'verifying') {
    reauthLandingAgain = true;
    if (finalDocument) reauthFinalDocumentSeen = true;
    return;
  }
  if (flow.phase !== 'pending') return;
  await setReauthFlow({ ...flow, phase: 'verifying' });
  await authCaptureQueue;
  const verification = await verifyTssSession(true);
  const current = await getReauthFlow();
  if (current?.windowId !== flow.windowId || current?.phase !== 'verifying') return;
  if (!verification.connected) {
    const retry = reauthLandingAgain;
    const finalLanding = finalDocument || reauthFinalDocumentSeen;
    reauthLandingAgain = false;
    reauthFinalDocumentSeen = false;
    await setReauthFlow({ ...flow, phase: finalLanding ? 'failed' : 'pending', error: finalLanding ? verification.error : undefined });
    if (retry && !finalLanding) finishReauth(tabId).catch(() => undefined);
    return;
  }
  reauthLandingAgain = false;
  reauthFinalDocumentSeen = false;
  await clearAuthFault();
  await setReauthFlow({ phase: 'connected', completedAt: Date.now() });
  await chrome.windows.remove(flow.windowId).catch(() => undefined);
}

async function handleReauthNavigation(tabId, change, tab) {
  if (!['loading', 'complete'].includes(change.status) || !(change.url || tab.url || tab.pendingUrl)) return;
  try {
    const landing = new URL(change.url || tab.url || tab.pendingUrl);
    if (landing.origin !== 'https://tss.ucsd.edu') return;
    const flow = await getReauthFlow();
    if (flow?.tabId !== tabId || !['pending', 'verifying'].includes(flow.phase)) return;
    if (landing.pathname === '/sap/saml2/sp/acs/500') {
      if (!flow.sawAcs) await setReauthFlow({ ...flow, sawAcs: true });
    } else if (landing.pathname === '/fiori' && flow.sawAcs && change.status === 'complete') {
      finishReauth(tabId).catch(() => undefined);
    }
  } catch {
    // Ignore navigations outside the TSS sign-in return path.
  }
}

chrome.tabs.onUpdated.addListener((tabId, change, tab) => {
  handleReauthNavigation(tabId, change, tab).catch(() => undefined);
});

chrome.windows.onRemoved.addListener((windowId) => {
  getReauthFlow().then((flow) => {
    if (flow?.windowId === windowId && ['pending', 'verifying'].includes(flow.phase)) {
      return setReauthFlow({ phase: 'cancelled' });
    }
  }).catch(() => undefined);
});

chrome.tabs.onRemoved.addListener((tabId) => {
  getReauthFlow().then((flow) => {
    if (flow?.tabId === tabId && ['pending', 'verifying'].includes(flow.phase)) {
      return setReauthFlow({ phase: 'cancelled' });
    }
  }).catch(() => undefined);
});

// ----- Multipart / JSON parsing helpers -----
function extractJson(text) {
  const start = text.indexOf('{');
  if (start === -1) return null;
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === '"') inStr = false;
    } else {
      if (c === '"') inStr = true;
      else if (c === '{') depth++;
      else if (c === '}') {
        depth--;
        if (depth === 0) {
          try {
            return JSON.parse(text.slice(start, i + 1));
          } catch (e) {
            return null;
          }
        }
      }
    }
  }
  return null;
}

function parseBatchResponse(text) {
  // Split on "--<boundary>" markers and pull JSON objects out of each part.
  const parts = text.split(/\r?\n--[A-Za-z0-9_\-]+/);
  const found = [];
  for (const part of parts) {
    const obj = extractJson(part);
    if (obj && Array.isArray(obj.value)) {
      found.push(...obj.value);
    }
  }
  return found;
}

function batchError(text) {
  const statuses = [...text.matchAll(/^HTTP\/1\.[01]\s+(\d{3})\b/gm)].map((match) => Number(match[1]));
  const status = statuses.find((value) => value >= 300);
  if (!status) return null;
  return { error: [301, 302, 303, 307, 308, 401, 403].includes(status) ? 'auth-expired' : 'http', status };
}

function parseTssJson(text) {
  try {
    return JSON.parse(text);
  } catch (error) {
    const embedded = extractJson(text);
    if (embedded) return embedded;
    throw error;
  }
}

// ----- API: search classes -----
async function searchClasses(term, query) {
  const auth = await getAuth();
  if (!authPresent(auth)) return { error: 'no-auth' };

  const boundary = `batch_id-${Date.now()}-${Math.floor(Math.random() * 1000)}`;
  const year = term.academicYear;
  const period = String(term.academicPeriod).padStart(3, '0');
  const searchEnc = encodeURIComponent(query);
  const filter = `(AcademicYear%20eq%20'${year}'%20or%20AcademicYear%20eq%20'${year}')%20and%20AcademicPeriod%20eq%20'${period}'`;
  const getLine =
    `GET YUCSD_CON_MODULE?sap-client=500&$count=true&$search=%22${searchEnc}%22` +
    `&$filter=${filter}&$select=${SEARCH_SELECT}&$skip=0&$top=30 HTTP/1.1`;
  const partHeaders =
    'Accept: application/json;odata.metadata=minimal;IEEE754Compatible=true\r\n' +
    'Accept-Language: en\r\n' +
    (auth.csrfToken ? `X-CSRF-Token: ${auth.csrfToken}\r\n` : '') +
    'Content-Type: application/json;charset=UTF-8;IEEE754Compatible=true\r\n';

  const body =
    `--${boundary}\r\n` +
    'Content-Type: application/http\r\n' +
    'Content-Transfer-Encoding: binary\r\n\r\n' +
    `${getLine}\r\n${partHeaders}\r\n` +
    '\r\n' +
    `--${boundary}--\r\n`;

  let resp;
  try {
    resp = await fetch(`${MODULE_BASE}/$batch?sap-client=500`, {
      method: 'POST',
      headers: {
        'Content-Type': `multipart/mixed; boundary=${boundary}`,
        Accept: 'multipart/mixed',
        'Accept-Language': 'en',
        'odata-maxversion': '4.0',
        'odata-version': '4.0',
        ...optionalAuthHeaders(auth),
        'x-requested-with': 'XMLHttpRequest',
        'x-xhr-logon': 'accept="iframe,strict-window,window"',
      },
      credentials: 'include',
      redirect: 'manual',
      body,
    });
  } catch (e) {
    return { error: 'network', message: e.message };
  }

  if (isAuthResponse(resp)) {
    return { error: 'auth-expired', status: resp.status };
  }
  if (!resp.ok) return { error: 'http', status: resp.status };

  const text = await resp.text();
  const innerError = batchError(text);
  if (innerError) return innerError;
  const raw = parseBatchResponse(text);
  const seen = new Set();
  const results = [];
  for (const v of raw) {
    if (!v.ModuleID || seen.has(v.ModuleID)) continue;
    seen.add(v.ModuleID);
    results.push({
      moduleID: v.ModuleID,
      courseAbbr: v.CourseAbbr,
      courseTitle: v.CourseTitle,
      credits: v.CreditsDisplay,
      departmentAbbr: v.DepartmentAbbr,
      academicYear: v.AcademicYear,
      academicPeriod: v.AcademicPeriod,
    });
  }
  return { results };
}

// ----- API: get sections for a course -----
async function getSections(moduleID, term, refreshId) {
  const auth = await getAuth();
  if (!authPresent(auth)) return { error: 'no-auth' };
  if (!/^\d+$/.test(String(moduleID || '')) || !/^\d+$/.test(String(term?.academicYear || '')) || !/^\d+$/.test(String(term?.academicPeriod || ''))) {
    return { error: 'invalid-request' };
  }

  const period = String(term.academicPeriod).padStart(3, '0');
  const url =
    `${MODULE_BASE}/YUCSD_CON_MODULE(AcademicYear='${term.academicYear}',` +
    `AcademicPeriod='${period}',ModuleID='${moduleID}')/_sections` +
    `?sap-client=500&$select=${SECTION_SELECT}&$skip=0&$top=1000`;

  const refreshRequest = createRefreshRequest(refreshId);
  try {
    const resp = await fetch(url, {
      headers: {
        Accept: 'application/json;odata.metadata=minimal;IEEE754Compatible=true',
        'Accept-Language': 'en',
        'odata-maxversion': '4.0',
        'odata-version': '4.0',
        ...optionalAuthHeaders(auth),
        'x-requested-with': 'XMLHttpRequest',
      },
      credentials: 'include',
      redirect: 'manual',
      signal: refreshRequest.signal,
    });
    if (isAuthResponse(resp)) {
      return { error: 'auth-expired', status: resp.status };
    }
    if (!resp.ok) return { error: 'http', status: resp.status };

    const text = (await resp.text()).replace(/^\uFEFF/, '').trim();
    let data;
    try {
      data = parseTssJson(text);
    } catch (error) {
      return {
        error: refreshRequest.signal?.aborted ? refreshRequest.result() : 'parse',
        message: refreshRequest.signal?.aborted ? undefined : `${error.message}; ${resp.headers.get('content-type') || 'unknown content type'}`,
      };
    }
    if (!Array.isArray(data?.value)) return { error: 'parse', message: 'TSS response did not contain a sections list' };
    return { sections: data.value };
  } catch (error) {
    return { error: refreshRequest.signal?.aborted ? refreshRequest.result() : 'network', message: error.message };
  } finally {
    refreshRequest.finish();
  }
}

// ----- API: get booking state and dated event schedules -----
async function fetchBookingDetails(moduleID, eventPkgObjid, term, refreshRequest) {
  if (refreshRequest.signal?.aborted) return { error: refreshRequest.result() };
  const auth = await getAuth();
  if (!authPresent(auth)) return { error: 'no-auth' };

  const year = String(term?.academicYear || '');
  const period = String(term?.academicPeriod || '');
  const packageID = String(eventPkgObjid || '');
  if (!/^\d+$/.test(moduleID) || !/^\d+$/.test(year) || !/^\d+$/.test(period) || !/^\d+$/.test(packageID)) {
    return { error: 'invalid-request' };
  }

  const url = `${BOOKING_BASE}/ModuleHeaderSet(` +
    `SmObjid='${moduleID}',SmOtype='SM',ScObjid='00000000',` +
    `ModregId=guid'00000000-0000-0000-0000-000000000000',` +
    `EventPackageId='${packageID}',AcademicYear='${year}',AcademicSession='${period}')` +
    `/Event?sap-client=500&$expand=BookingCheckLog%2CRequest%2CEventSchedule%2CCreditOptions`;

  try {
    const resp = await fetch(url, {
      headers: {
        Accept: 'application/json',
        'Accept-Language': 'en',
        ...optionalAuthHeaders(auth),
        'x-requested-with': 'XMLHttpRequest',
      },
      credentials: 'include',
      redirect: 'manual',
      signal: refreshRequest.signal,
    });
    if (isAuthResponse(resp)) {
      return { error: 'auth-expired', status: resp.status };
    }
    if (!resp.ok) return { error: 'http', status: resp.status };

    const text = (await resp.text()).replace(/^\uFEFF/, '').trim();
    let data;
    try {
      data = parseTssJson(text);
    } catch (error) {
      return {
        error: refreshRequest.signal?.aborted ? refreshRequest.result() : 'parse',
        message: refreshRequest.signal?.aborted ? undefined : `${error.message}; ${resp.headers.get('content-type') || 'unknown content type'}`,
      };
    }
    if (!Array.isArray(data?.d?.results)) return { error: 'parse', message: 'TSS response did not contain booking details' };
    return { events: data.d.results };
  } catch (error) {
    return { error: refreshRequest.signal?.aborted ? refreshRequest.result() : 'network', message: error.message };
  }
}

function getBookingDetails(moduleID, eventPkgObjid, term, refreshId) {
  const refreshRequest = createRefreshRequest(refreshId);
  const request = bookingRequestQueue.then(async () => {
    const pause = Math.max(0, 1200 - (Date.now() - lastBookingRequestAt));
    if (pause) await new Promise((resolve) => setTimeout(resolve, pause));
    if (refreshRequest.signal?.aborted) return { error: refreshRequest.result() };
    lastBookingRequestAt = Date.now();
    return fetchBookingDetails(moduleID, eventPkgObjid, term, refreshRequest);
  });
  bookingRequestQueue = request.catch(() => undefined);
  return request.finally(refreshRequest.finish);
}

// ----- API: get prerequisites -----
function formatDate(d) {
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

async function getRequirements(moduleID) {
  const auth = await getAuth();
  if (!authPresent(auth)) return { error: 'no-auth' };

  const boundary = `batch_id-${Date.now()}-${Math.floor(Math.random() * 1000)}`;
  const keydate = formatDate(new Date());
  const getLine = `GET YUCSD_I_PREREQ_TREE(moduleid='${moduleID}',keydate=${keydate})/Set?$skip=0&$top=100 HTTP/1.1`;
  const partHeaders =
    'Accept: application/json;odata.metadata=minimal;IEEE754Compatible=true\r\n' +
    'Accept-Language: en\r\n' +
    (auth.csrfToken ? `X-CSRF-Token: ${auth.csrfToken}\r\n` : '') +
    'Content-Type: application/json;charset=UTF-8;IEEE754Compatible=true\r\n';

  const body =
    `--${boundary}\r\n` +
    'Content-Type: application/http\r\n' +
    'Content-Transfer-Encoding: binary\r\n\r\n' +
    `${getLine}\r\n${partHeaders}\r\n` +
    '\r\n' +
    `--${boundary}--\r\n`;

  let resp;
  try {
    resp = await fetch(`${MODULE_BASE}/$batch?sap-client=500`, {
      method: 'POST',
      headers: {
        'Content-Type': `multipart/mixed; boundary=${boundary}`,
        Accept: 'multipart/mixed',
        'Accept-Language': 'en',
        'odata-maxversion': '4.0',
        'odata-version': '4.0',
        ...optionalAuthHeaders(auth),
        'x-requested-with': 'XMLHttpRequest',
        'x-xhr-logon': 'accept="iframe,strict-window,window"',
      },
      credentials: 'include',
      redirect: 'manual',
      body,
    });
  } catch (e) {
    return { error: 'network', message: e.message };
  }

  if (isAuthResponse(resp)) {
    return { error: 'auth-expired', status: resp.status };
  }
  if (!resp.ok) return { error: 'http', status: resp.status };

  const text = await resp.text();
  const innerError = batchError(text);
  if (innerError) return innerError;
  const obj = extractJson(text);
  return { requirements: (obj && obj.value) || [] };
}

// ----- Message router -----
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type === 'tssFioriReady') {
    const tabId = _sender.tab?.id;
    if (tabId && _sender.url?.startsWith('https://tss.ucsd.edu/fiori')) {
      finishReauth(tabId, true).catch(() => undefined);
    }
    sendResponse({ received: true });
    return false;
  }
  if (msg.type === 'searchClasses') {
    trackApiResult(msg.type, searchClasses(msg.term, msg.query)).then(sendResponse);
    return true;
  }
  if (msg.type === 'getSections') {
    trackApiResult(msg.type, getSections(msg.moduleID, msg.term, msg.refreshId)).then(sendResponse);
    return true;
  }
  if (msg.type === 'getBookingDetails') {
    trackApiResult(msg.type, getBookingDetails(msg.moduleID, msg.eventPkgObjid, msg.term, msg.refreshId)).then(sendResponse);
    return true;
  }
  if (msg.type === 'cancelRefresh') {
    sendResponse({ cancelled: cancelRefresh(msg.refreshId) });
    return false;
  }
  if (msg.type === 'finishRefresh') {
    finishRefresh(msg.refreshId);
    sendResponse({ finished: true });
    return false;
  }
  if (msg.type === 'getRequirements') {
    trackApiResult(msg.type, getRequirements(msg.moduleID)).then(sendResponse);
    return true;
  }
  if (msg.type === 'getSessionStatus') {
    getSessionStatus().then(sendResponse);
    return true;
  }
  if (msg.type === 'startReauth') {
    console.info('Re-auth request received');
    const flow = startReauth();
    // Reply before the sign-in window takes focus; Chrome may close an action
    // popup as soon as that browser window opens.
    sendResponse({ phase: 'pending' });
    flow.catch((error) => {
      const detail = getReauthErrorDetail(error);
      console.error('Re-auth startup failed unexpectedly:', detail);
      setReauthFlow({ phase: 'failed', error: 'background', detail }).catch(() => undefined);
    });
    return false;
  }
  return false;
});
