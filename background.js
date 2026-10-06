// Service worker: passively captures auth headers from TSS requests and
// proxies class-search / section-detail API calls on behalf of the popup.

const MODULE_BASE =
  'https://tss.ucsd.edu/sap/opu/odata4/sap/yucsd_con_module_sb/srvd/sap/yucsd_con_module_servicedef/0001';
const BOOKING_BASE = 'https://tss.ucsd.edu/sap/opu/odata/ITUS/PR_MY_MODULES_V2_SRV';
const SEARCH_SELECT =
  'AcademicLevel,AcademicPeriod,AcademicYear,CourseAbbr,CourseTitle,CreditsDisplay,DepartmentAbbr,DepartmentText,ModuleID,incrementDisplay';
const SECTION_SELECT =
  'AcPeriod,AcYear,EventAbbr,EventID,EventPkgDisable,EventPkgDisplayID,EventPkgLimit,EventPkgNumOnWaitl,EventPkgObjid,EventPkgOtjid,EventPkgSeatsAvailable,EventPkgSemanticColorCapacity,EventPkgStatusText,EventPkgText,InstructorEmail,InstructorName,ModuleID,Sched,Status,StatusSemantic,TeachingMethod,TeachingMethod_Text,locationText';
let bookingRequestQueue = Promise.resolve();
let lastBookingRequestAt = 0;
let authCaptureQueue = Promise.resolve();
const refreshRequestControllers = new Map();
const cancelledRefreshIds = new Set();

function captureAuthHeaders(headers) {
  authCaptureQueue = authCaptureQueue.then(async () => {
    const { auth: previous } = await chrome.storage.local.get('auth');
    const now = Date.now();
    const next = {
      cookie: headers.cookie || previous?.cookie || null,
      sapPassport: headers.sapPassport || previous?.sapPassport || null,
      csrfToken: headers.csrfToken || previous?.csrfToken || null,
    };
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
      else if (n === 'x-csrf-token') headers.csrfToken = h.value;
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
  return { connected: Boolean(authPresent(auth)), capturedAt: auth?.capturedAt || null };
}

function authPresent(auth) {
  return auth && (auth.cookie || auth.csrfToken || auth.sapPassport);
}

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
    `X-CSRF-Token: ${auth.csrfToken || ''}\r\n` +
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
        'sap-passport': auth.sapPassport || '',
        'x-csrf-token': auth.csrfToken || '',
        'x-requested-with': 'XMLHttpRequest',
        'x-xhr-logon': 'accept="iframe,strict-window,window"',
      },
      credentials: 'include',
      body,
    });
  } catch (e) {
    return { error: 'network', message: e.message };
  }

  if (resp.status === 401 || resp.status === 403 || resp.status === 302) {
    return { error: 'auth-expired', status: resp.status };
  }
  if (!resp.ok) return { error: 'http', status: resp.status };

  const text = await resp.text();
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
        'sap-passport': auth.sapPassport || '',
        'x-csrf-token': auth.csrfToken || '',
        'x-requested-with': 'XMLHttpRequest',
      },
      credentials: 'include',
      signal: refreshRequest.signal,
    });
    if (resp.status === 401 || resp.status === 403 || resp.status === 302) {
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
        'sap-passport': auth.sapPassport || '',
        'x-csrf-token': auth.csrfToken || '',
        'x-requested-with': 'XMLHttpRequest',
      },
      credentials: 'include',
      signal: refreshRequest.signal,
    });
    if (resp.status === 401 || resp.status === 403 || resp.status === 302) {
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
    `X-CSRF-Token: ${auth.csrfToken || ''}\r\n` +
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
        'sap-passport': auth.sapPassport || '',
        'x-csrf-token': auth.csrfToken || '',
        'x-requested-with': 'XMLHttpRequest',
        'x-xhr-logon': 'accept="iframe,strict-window,window"',
      },
      credentials: 'include',
      body,
    });
  } catch (e) {
    return { error: 'network', message: e.message };
  }

  if (resp.status === 401 || resp.status === 403 || resp.status === 302) {
    return { error: 'auth-expired', status: resp.status };
  }
  if (!resp.ok) return { error: 'http', status: resp.status };

  const text = await resp.text();
  const obj = extractJson(text);
  return { requirements: (obj && obj.value) || [] };
}

// ----- Message router -----
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type === 'searchClasses') {
    searchClasses(msg.term, msg.query).then(sendResponse);
    return true;
  }
  if (msg.type === 'getSections') {
    getSections(msg.moduleID, msg.term, msg.refreshId).then(sendResponse);
    return true;
  }
  if (msg.type === 'getBookingDetails') {
    getBookingDetails(msg.moduleID, msg.eventPkgObjid, msg.term, msg.refreshId).then(sendResponse);
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
    getRequirements(msg.moduleID).then(sendResponse);
    return true;
  }
  if (msg.type === 'getSessionStatus') {
    getSessionStatus().then(sendResponse);
    return true;
  }
  return false;
});
