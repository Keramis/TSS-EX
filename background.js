// Service worker: passively captures auth headers from TSS requests and
// proxies class-search / section-detail API calls on behalf of the popup.

const MODULE_BASE =
  'https://tss.ucsd.edu/sap/opu/odata4/sap/yucsd_con_module_sb/srvd/sap/yucsd_con_module_servicedef/0001';
const UTILS_URL_FILTER = 'https://tss.ucsd.edu/sap/opu/odata4/sap/ysb_fiori_utils/*';

const SEARCH_SELECT =
  'AcademicLevel,AcademicPeriod,AcademicYear,CourseAbbr,CourseTitle,CreditsDisplay,DepartmentAbbr,DepartmentText,ModuleID,incrementDisplay';
const SECTION_SELECT =
  'AcPeriod,AcYear,EventAbbr,EventID,EventPkgDisable,EventPkgDisplayID,EventPkgLimit,EventPkgNumOnWaitl,EventPkgObjid,EventPkgOtjid,EventPkgSeatsAvailable,EventPkgSemanticColorCapacity,EventPkgStatusText,EventPkgText,InstructorEmail,InstructorName,ModuleID,Sched,Status,StatusSemantic,TeachingMethod,TeachingMethod_Text,locationText';

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
    if (headers.cookie || headers.sapPassport || headers.csrfToken) {
      chrome.storage.local.set({
        auth: {
          cookie: headers.cookie || null,
          sapPassport: headers.sapPassport || null,
          csrfToken: headers.csrfToken || null,
          capturedAt: Date.now(),
        },
      });
    }
  },
  { urls: [UTILS_URL_FILTER] },
  ['requestHeaders', 'extraHeaders']
);

async function getAuth() {
  const { auth } = await chrome.storage.local.get('auth');
  return auth;
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
async function getSections(moduleID, term) {
  const auth = await getAuth();
  if (!authPresent(auth)) return { error: 'no-auth' };

  const period = String(term.academicPeriod).padStart(3, '0');
  const url =
    `${MODULE_BASE}/YUCSD_CON_MODULE(AcademicYear='${term.academicYear}',` +
    `AcademicPeriod='${period}',ModuleID='${moduleID}')/_sections` +
    `?sap-client=500&$select=${SECTION_SELECT}&$skip=0&$top=1000`;

  let resp;
  try {
    resp = await fetch(url, {
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
    });
  } catch (e) {
    return { error: 'network', message: e.message };
  }

  if (resp.status === 401 || resp.status === 403 || resp.status === 302) {
    return { error: 'auth-expired', status: resp.status };
  }
  if (!resp.ok) return { error: 'http', status: resp.status };

  let data;
  try {
    data = await resp.json();
  } catch (e) {
    return { error: 'parse', message: e.message };
  }
  return { sections: data.value || [] };
}

// ----- Message router -----
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type === 'searchClasses') {
    searchClasses(msg.term, msg.query).then(sendResponse);
    return true;
  }
  if (msg.type === 'getSections') {
    getSections(msg.moduleID, msg.term).then(sendResponse);
    return true;
  }
  if (msg.type === 'getAuth') {
    getAuth().then((auth) => sendResponse({ auth }));
    return true;
  }
  return false;
});
