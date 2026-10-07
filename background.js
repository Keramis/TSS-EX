// Service worker: passively captures auth headers from TSS requests and
// proxies class-search / section-detail API calls on behalf of the popup.

const MODULE_BASE =
  'https://tss.ucsd.edu/sap/opu/odata4/sap/yucsd_con_module_sb/srvd/sap/yucsd_con_module_servicedef/0001';
const BOOKING_BASE = 'https://tss.ucsd.edu/sap/opu/odata/ITUS/PR_MY_MODULES_V2_SRV';
const AUTH_START_URL = 'https://sis.ucsd.edu/';
const CUSTOM_AUTH_START_URL = 'https://tss.ucsd.edu/fiori';
const DUO_HOST = 'api-ce13a1a7.duosecurity.com';
const CUSTOM_CREDENTIALS_KEY = 'customReauthCredentials';
const CUSTOM_REAUTH_TIMEOUT_ALARM = 'customReauthTimeout';
const CUSTOM_REAUTH_ERROR_DETAILS = {
  'proxy-choice-not-found': 'Could not select UCSD SSO on the TSS sign-in page.',
  'helper-not-loaded': 'The UCSD sign-in page did not start the automation. Reload the extension and try again.',
  'a5-form-not-found': 'The UCSD sign-in form did not load.',
  'a5-form-not-recognized': 'The UCSD sign-in form was not recognized. Try the official popup.',
  'credentials-unavailable': 'Sign-in credentials were no longer available. Try again.',
  'a5-submit-failed': 'Could not submit the UCSD sign-in form.',
  'a5-login-not-accepted': 'UCSD sign-in did not advance after credentials were submitted.',
  'injection-failed': 'Could not automate the UCSD sign-in page. Try the official popup.',
  'duo-window-failed': 'Could not open the Duo prompt window.',
  'flow-timeout': 'UCSD sign-in did not reach Duo or TSS in time. Try the official popup.',
};
const CUSTOM_REAUTH_AUTOMATION_STAGES = {
  'tssproxy.ucsd.edu': new Set(['helper-loaded', 'chooser-found']),
  'a5.ucsd.edu': new Set(['helper-loaded', 'credential-form-found', 'credentials-submitting']),
};
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
let customReauthStartPromise = null;
let customCredentialsClaimed = false;
const customDuoOpeningTabs = new Set();
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
  if (['automating', 'duo-opening', 'pending', 'verifying'].includes(flow?.phase)) {
    return {
      connected: false,
      capturedAt: auth?.capturedAt || null,
      reauthPhase: flow.phase,
      reauthStrategy: flow.strategy || 'official',
      reauthStep: flow.automationStage || null,
    };
  }
  const reauthError = flow?.phase === 'failed' ? (flow.detail || flow.error || null) : null;
  const fault = await getAuthFault();
  if (fault) {
    return {
      connected: false,
      capturedAt: auth?.capturedAt || null,
      reauthPhase: flow?.phase || null,
      reauthStrategy: flow?.strategy || null,
      reauthError,
      error: fault.error,
    };
  }
  const verification = await verifyTssSession();
  return {
    connected: verification.connected,
    capturedAt: (await getAuth())?.capturedAt || null,
    reauthPhase: verification.connected ? 'connected' : flow?.phase || null,
    reauthStrategy: flow?.strategy || null,
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

function isActiveReauth(flow) {
  return ['automating', 'duo-opening', 'pending', 'verifying'].includes(flow?.phase);
}

async function closeReauthTarget(flow) {
  if (flow?.ownsWindow && Number.isInteger(flow.windowId)) {
    await chrome.windows.remove(flow.windowId).catch(() => undefined);
    return;
  }
  if (flow?.strategy === 'custom' || flow?.managedTab) {
    if (Number.isInteger(flow.tabId)) await chrome.tabs.remove(flow.tabId).catch(() => undefined);
    return;
  }
  if (Number.isInteger(flow?.windowId)) {
    await chrome.windows.remove(flow.windowId).catch(() => undefined);
  } else if (Number.isInteger(flow?.tabId)) {
    await chrome.tabs.remove(flow.tabId).catch(() => undefined);
  }
}

function scheduleCustomReauthTimeout(alarmInfo) {
  try {
    const result = chrome.alarms?.create?.(CUSTOM_REAUTH_TIMEOUT_ALARM, alarmInfo);
    result?.catch?.(() => undefined);
  } catch {
    // Search and session checks must still work if alarms are unavailable.
  }
}

function clearCustomReauthTimeout() {
  try {
    const result = chrome.alarms?.clear?.(CUSTOM_REAUTH_TIMEOUT_ALARM);
    result?.catch?.(() => undefined);
  } catch {
    // Alarm cleanup is best effort; credentials also expire with the browser session.
  }
}

async function clearCustomCredentials() {
  customCredentialsClaimed = false;
  await chrome.storage.session.remove(CUSTOM_CREDENTIALS_KEY).catch(() => undefined);
  clearCustomReauthTimeout();
}

async function failCustomReauth(code) {
  const flow = await getReauthFlow();
  if (flow?.strategy !== 'custom' || !isActiveReauth(flow)) return;
  const failureCode = Object.hasOwn(CUSTOM_REAUTH_ERROR_DETAILS, code) ? code : 'injection-failed';
  await clearCustomCredentials();
  await setReauthFlow({
    ...flow,
    phase: 'failed',
    error: failureCode,
    detail: CUSTOM_REAUTH_ERROR_DETAILS[failureCode],
  });
  await closeReauthTarget(flow);
}

async function focusActiveReauth(flow) {
  if (flow?.strategy === 'custom' && flow.phase === 'automating') return true;
  if (!Number.isInteger(flow?.windowId)) return false;
  try {
    await chrome.tabs.get(flow.tabId);
    await chrome.windows.get(flow.windowId);
    await chrome.windows.update(flow.windowId, { focused: true });
    return true;
  } catch {
    return false;
  }
}

async function startReauth() {
  if (reauthStartPromise) return reauthStartPromise;
  reauthStartPromise = (async () => {
    let windowId = null;
    try {
      const previous = await getReauthFlow();
      if (isActiveReauth(previous) && await focusActiveReauth(previous)) {
        return { phase: previous.phase, strategy: previous.strategy || 'official' };
      }
      await closeReauthTarget(previous);
      await clearCustomCredentials();
      reauthLandingAgain = false;
      reauthFinalDocumentSeen = false;
      await chrome.storage.session.remove(TSS_SESSION_CACHE_KEY).catch(() => undefined);
      const startedAt = Date.now();
      await setReauthFlow({ phase: 'pending', strategy: 'official', ownsWindow: true, sawAcs: false, startedAt });
      const loginWindow = await chrome.windows.create({
        url: 'about:blank', type: 'popup', width: 600, height: 800, focused: true,
      });
      windowId = loginWindow?.id;
      if (!Number.isInteger(windowId)) throw new Error('Sign-in window did not open');
      const [tab] = await chrome.tabs.query({ windowId });
      if (!Number.isInteger(tab?.id)) throw new Error('Sign-in tab did not open');
      await setReauthFlow({
        phase: 'pending', strategy: 'official', ownsWindow: true,
        windowId, tabId: tab.id, sawAcs: false, startedAt,
      });
      await chrome.tabs.update(tab.id, { url: AUTH_START_URL });
      return { phase: 'pending' };
    } catch (error) {
      const detail = 'Could not open the UCSD sign-in window.';
      if (windowId !== null) await chrome.windows.remove(windowId).catch(() => undefined);
      await setReauthFlow({ phase: 'failed', strategy: 'official', error: 'window', detail }).catch(() => undefined);
      return { phase: 'failed', error: 'window', detail };
    }
  })();
  try {
    return await reauthStartPromise;
  } finally {
    reauthStartPromise = null;
  }
}

async function startCustomReauth(username, password) {
  if (customReauthStartPromise) return customReauthStartPromise;
  customReauthStartPromise = (async () => {
    let tab = null;
    try {
      const previous = await getReauthFlow();
      if (isActiveReauth(previous)) return { phase: previous.phase, strategy: previous.strategy };
      await closeReauthTarget(previous);
      await clearCustomCredentials();
      reauthLandingAgain = false;
      reauthFinalDocumentSeen = false;
      await chrome.storage.session.remove(TSS_SESSION_CACHE_KEY).catch(() => undefined);
      await clearAuthFault();

      const requiredHosts = ['tssproxy.ucsd.edu', 'a5.ucsd.edu'];
      const scripts = chrome.runtime.getManifest().content_scripts || [];
      const helperRegistered = requiredHosts.every((host) => scripts.some((script) =>
        script.js?.includes('reauth-content.js') && script.matches?.includes(`https://${host}/*`)));
      const hostAccess = await chrome.permissions.contains({
        origins: requiredHosts.map((host) => `https://${host}/*`),
      });
      if (!helperRegistered || !hostAccess) {
        const error = !helperRegistered ? 'helper-not-registered' : 'host-access-missing';
        const detail = !helperRegistered
          ? 'The loaded extension manifest does not register the sign-in helper. Reload UCSD EZPLAN on the browser extensions page and confirm it uses the updated project folder.'
          : 'UCSD EZPLAN does not have access to tssproxy.ucsd.edu and a5.ucsd.edu. Check its site access on the browser extensions page and reload the extension.';
        await setReauthFlow({ phase: 'failed', strategy: 'custom', error, detail });
        return { phase: 'failed', strategy: 'custom', error, detail };
      }

      tab = await chrome.tabs.create({ url: 'about:blank', active: false });
      if (!Number.isInteger(tab?.id)) throw new Error('Could not create sign-in tab');
      const flow = {
        phase: 'automating',
        strategy: 'custom',
        managedTab: true,
        ownsWindow: false,
        windowId: tab.windowId,
        tabId: tab.id,
        sawAcs: false,
        startedAt: Date.now(),
      };
      await setReauthFlow(flow);
      await chrome.storage.session.set({
        [CUSTOM_CREDENTIALS_KEY]: { username, password, expiresAt: Date.now() + 2 * 60 * 1000 },
      });
      scheduleCustomReauthTimeout({ delayInMinutes: 2 });
      customCredentialsClaimed = false;
      await chrome.tabs.update(tab.id, { url: CUSTOM_AUTH_START_URL });
      return { phase: 'automating', strategy: 'custom' };
    } catch {
      await clearCustomCredentials();
      if (Number.isInteger(tab?.id)) await chrome.tabs.remove(tab.id).catch(() => undefined);
      const detail = 'Could not start the custom UCSD sign-in flow.';
      await setReauthFlow({ phase: 'failed', strategy: 'custom', error: 'startup', detail }).catch(() => undefined);
      return { phase: 'failed', strategy: 'custom', error: 'startup', detail };
    }
  })();
  try {
    return await customReauthStartPromise;
  } finally {
    customReauthStartPromise = null;
  }
}

async function takeCustomReauthCredentials(sender) {
  const senderUrl = sender?.url || sender?.tab?.url || '';
  let origin = '';
  try {
    origin = new URL(senderUrl).origin;
  } catch {
    return null;
  }
  if (origin !== 'https://a5.ucsd.edu') return null;

  const flow = await getReauthFlow();
  if (flow?.strategy !== 'custom' || flow.phase !== 'automating' || flow.tabId !== sender?.tab?.id) return null;
  if (customCredentialsClaimed) return null;
  customCredentialsClaimed = true;

  const { [CUSTOM_CREDENTIALS_KEY]: credentials } = await chrome.storage.session.get(CUSTOM_CREDENTIALS_KEY);
  await chrome.storage.session.remove(CUSTOM_CREDENTIALS_KEY).catch(() => undefined);
  if (!credentials
      || !Number.isFinite(credentials.expiresAt)
      || credentials.expiresAt <= Date.now()
      || typeof credentials.username !== 'string'
      || typeof credentials.password !== 'string') return null;

  const current = await getReauthFlow();
  if (current?.strategy !== 'custom' || current.phase !== 'automating' || current.tabId !== sender.tab.id) return null;
  return { username: credentials.username, password: credentials.password };
}

async function handleCustomReauthNavigation(tabId, change, tab) {
  const navigationUrl = change.url || (change.status === 'loading' && tab.pendingUrl) || tab.url || tab.pendingUrl;
  if (!['loading', 'complete'].includes(change.status) || !navigationUrl) return;
  let url;
  try {
    url = new URL(navigationUrl);
  } catch {
    return;
  }

  const flow = await getReauthFlow();
  if (flow?.strategy !== 'custom' || flow.tabId !== tabId) return;
  if (url.hostname === DUO_HOST && flow.phase === 'automating') {
    if (customDuoOpeningTabs.has(tabId)) return;
    customDuoOpeningTabs.add(tabId);
    try {
      const currentFlow = await getReauthFlow();
      if (currentFlow?.strategy !== 'custom' || currentFlow.tabId !== tabId || currentFlow.phase !== 'automating') return;
      await setReauthFlow({ ...currentFlow, phase: 'duo-opening' });
      const popup = await chrome.windows.create({
        tabId,
        type: 'popup',
        width: 600,
        height: 800,
        focused: true,
      });
      const current = await getReauthFlow();
      if (current?.strategy !== 'custom' || current.tabId !== tabId || current.phase !== 'duo-opening') {
        if (Number.isInteger(popup?.id)) await chrome.windows.remove(popup.id).catch(() => undefined);
        return;
      }
      await setReauthFlow({
        ...current,
        phase: 'pending',
        ownsWindow: true,
        windowId: popup.id,
        duoOpened: true,
      });
    } catch {
      await failCustomReauth('duo-window-failed');
    } finally {
      customDuoOpeningTabs.delete(tabId);
    }
    return;
  }

  // The sign-in helper is a document_end content script. Its messages are
  // gated by the active custom flow and this tab's ID in the message router.
}

async function finishReauth(tabId, finalDocument = false) {
  const flow = await getReauthFlow();
  if (flow?.tabId !== tabId) return;
  if (flow.phase === 'verifying') {
    reauthLandingAgain = true;
    if (finalDocument) reauthFinalDocumentSeen = true;
    return;
  }
  if (!['automating', 'pending'].includes(flow.phase)) return;
  await setReauthFlow({ ...flow, phase: 'verifying' });
  await authCaptureQueue;
  const verification = await verifyTssSession(true);
  const current = await getReauthFlow();
  if (current?.tabId !== tabId || current?.startedAt !== flow.startedAt || current?.phase !== 'verifying') return;
  if (!verification.connected) {
    const retry = reauthLandingAgain;
    const finalLanding = finalDocument || reauthFinalDocumentSeen;
    reauthLandingAgain = false;
    reauthFinalDocumentSeen = false;
    await setReauthFlow({
      ...flow,
      phase: finalLanding ? 'failed' : flow.strategy === 'custom' ? 'automating' : 'pending',
      error: finalLanding ? verification.error : undefined,
      detail: finalLanding && flow.strategy === 'custom'
        ? 'The TSS session could not be confirmed after sign-in.'
        : undefined,
    });
    if (finalLanding && flow.strategy === 'custom') {
      await clearCustomCredentials();
      await closeReauthTarget(flow);
    }
    if (retry && !finalLanding) finishReauth(tabId).catch(() => undefined);
    return;
  }
  reauthLandingAgain = false;
  reauthFinalDocumentSeen = false;
  await clearAuthFault();
  await setReauthFlow({ phase: 'connected', completedAt: Date.now() });
  await clearCustomCredentials();
  await closeReauthTarget(flow);
}

async function handleReauthNavigation(tabId, change, tab) {
  if (!['loading', 'complete'].includes(change.status) || !(change.url || tab.url || tab.pendingUrl)) return;
  try {
    const landing = new URL(change.url || tab.url || tab.pendingUrl);
    if (landing.origin !== 'https://tss.ucsd.edu') return;
    const flow = await getReauthFlow();
    if (flow?.tabId !== tabId || !['automating', 'pending', 'verifying'].includes(flow.phase)) return;
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
  handleCustomReauthNavigation(tabId, change, tab).catch(() => undefined);
});

chrome.windows.onRemoved.addListener((windowId) => {
  getReauthFlow().then((flow) => {
    if (flow?.windowId === windowId && isActiveReauth(flow)) {
      clearCustomCredentials().catch(() => undefined);
      return setReauthFlow({ phase: 'cancelled', strategy: flow.strategy });
    }
  }).catch(() => undefined);
});

chrome.tabs.onRemoved.addListener((tabId) => {
  getReauthFlow().then((flow) => {
    if (flow?.tabId === tabId && isActiveReauth(flow)) {
      clearCustomCredentials().catch(() => undefined);
      return setReauthFlow({ phase: 'cancelled', strategy: flow.strategy });
    }
  }).catch(() => undefined);
});

try {
  chrome.alarms?.onAlarm?.addListener((alarm) => {
    if (alarm.name !== CUSTOM_REAUTH_TIMEOUT_ALARM) return;
    chrome.storage.session.get(CUSTOM_CREDENTIALS_KEY).then(async (stored) => {
      const credentials = stored[CUSTOM_CREDENTIALS_KEY];
      const flow = await getReauthFlow();
      const now = Date.now();
      if (flow?.strategy === 'custom'
          && flow.phase === 'automating'
          && Number.isFinite(flow.startedAt)) {
        const deadline = Math.min(
          flow.startedAt + 2 * 60 * 1000,
          Number.isFinite(credentials?.expiresAt) ? credentials.expiresAt : Infinity,
        );
        if (deadline > now) scheduleCustomReauthTimeout({ when: deadline });
        else await failCustomReauth(flow.automationHost ? 'flow-timeout' : 'helper-not-loaded');
      }
    }).catch(() => undefined);
  });
} catch {
  // The service worker still registers its message handlers without alarms.
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
  let text;
  const controller = new AbortController();
  const requestTimeout = setTimeout(() => controller.abort(), 25000);
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
      signal: controller.signal,
    });
    if (isAuthResponse(resp)) return { error: 'auth-expired', status: resp.status };
    if (!resp.ok) return { error: 'http', status: resp.status };
    text = await resp.text();
  } catch (e) {
    return { error: 'network', message: e.message };
  } finally {
    clearTimeout(requestTimeout);
  }

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

// Only fixed diagnostic fields leave the worker: no credentials, cookies,
// page contents, query strings, SAML payloads, or CSRF tokens.
async function getReauthDiagnostics() {
  const flow = await getReauthFlow();
  const manifest = chrome.runtime.getManifest();
  const report = {
    revision: 'intercept-diagnostics-1',
    extensionId: chrome.runtime.id,
    version: manifest.version,
    helperRegistration: (manifest.content_scripts || [])
      .filter((script) => script.js?.includes('reauth-content.js'))
      .map(({ matches, run_at }) => ({ matches, runAt: run_at || 'document_idle' })),
    hostAccess: {},
    flow: flow ? {
      strategy: flow.strategy, phase: flow.phase,
      stage: flow.automationStage || null, host: flow.automationHost || null,
      error: flow.error || null,
    } : null,
    tab: null,
    helper: { status: 'not-probed' },
  };
  for (const host of ['tssproxy.ucsd.edu', 'a5.ucsd.edu']) {
    report.hostAccess[host] = await chrome.permissions.contains({ origins: [`https://${host}/*`] });
  }
  if (!Number.isInteger(flow?.tabId)) return report;
  let tab;
  try {
    tab = await chrome.tabs.get(flow.tabId);
  } catch {
    report.tab = { status: 'closed-or-unavailable' };
    return report;
  }
  let host = null;
  try { host = new URL(tab.url || tab.pendingUrl).hostname; } catch { /* URL may be withheld. */ }
  report.tab = { host, status: tab.status || 'unknown' };
  let timeout;
  try {
    const response = await Promise.race([
      chrome.tabs.sendMessage(tab.id, { type: 'probeCustomReauthHelper' }, { frameId: 0 }),
      new Promise((resolve) => { timeout = setTimeout(() => resolve(null), 2000); }),
    ]);
    report.helper = response ? {
      status: 'responded', revision: response.revision,
      stage: response.stage, handshake: response.handshake,
      messagingError: response.messagingError, failure: response.failure,
      readyState: response.readyState,
    } : { status: 'no-response' };
  } catch {
    report.helper = { status: 'no-receiver-or-tab-navigating' };
  } finally {
    clearTimeout(timeout);
  }
  return report;
}

// ----- Message router -----
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === 'getReauthDiagnostics') {
    if (sender.id !== chrome.runtime.id || !sender.url?.startsWith(chrome.runtime.getURL(''))) return false;
    getReauthDiagnostics().then(sendResponse).catch(() => sendResponse({ error: 'diagnostics-unavailable' }));
    return true;
  }
  if (msg.type === 'requestCustomReauthCredentials') {
    takeCustomReauthCredentials(sender).then(async (credentials) => {
      if (credentials) {
        sendResponse(credentials);
        return;
      }
      const senderUrl = sender?.url || sender?.tab?.url || '';
      let senderOrigin = '';
      try { senderOrigin = new URL(senderUrl).origin; } catch { /* ignore malformed sender URLs */ }
      const flow = await getReauthFlow();
      if (senderOrigin === 'https://a5.ucsd.edu'
          && flow?.strategy === 'custom'
          && flow.phase === 'automating'
          && flow.tabId === sender?.tab?.id) {
        await failCustomReauth('credentials-unavailable');
      }
      sendResponse({ error: 'credentials-unavailable' });
    }).catch(() => sendResponse({ error: 'credentials-unavailable' }));
    return true;
  }
  if (msg.type === 'customReauthAutomationProgress') {
    (async () => {
      const flow = await getReauthFlow();
      const senderUrl = sender?.url || sender?.tab?.url || '';
      let senderHost = '';
      try { senderHost = new URL(senderUrl).hostname; } catch { /* ignore malformed sender URLs */ }
      const allowedStages = CUSTOM_REAUTH_AUTOMATION_STAGES[senderHost];
      const accepted = flow?.strategy === 'custom'
        && flow.phase === 'automating'
        && flow.tabId === sender?.tab?.id
        && allowedStages?.has(msg.stage) === true;
      if (!accepted) {
        const reason = flow?.strategy !== 'custom' ? 'no-custom-flow'
          : flow.phase !== 'automating' ? 'flow-not-automating'
          : flow.tabId !== sender?.tab?.id ? 'wrong-tab'
          : 'host-or-stage-not-allowed';
        sendResponse({ accepted: false, reason });
        return;
      }
      await setReauthFlow({
        ...flow,
        automationHost: senderHost,
        automationStage: msg.stage,
        automationAt: Date.now(),
      });
      sendResponse({ accepted: true });
    })().catch(() => sendResponse({ accepted: false, reason: 'worker-handler-error' }));
    return true;
  }
  if (msg.type === 'customReauthAutomationError') {
    (async () => {
      const flow = await getReauthFlow();
      const senderUrl = sender?.url || sender?.tab?.url || '';
      let senderOrigin = '';
      try { senderOrigin = new URL(senderUrl).origin; } catch { /* ignore malformed sender URLs */ }
      if (flow?.strategy === 'custom'
          && flow.tabId === sender?.tab?.id
          && ['https://tssproxy.ucsd.edu', 'https://a5.ucsd.edu'].includes(senderOrigin)) {
        const code = typeof msg.code === 'string' && Object.hasOwn(CUSTOM_REAUTH_ERROR_DETAILS, msg.code)
          ? msg.code
          : 'injection-failed';
        await failCustomReauth(code);
      }
      sendResponse({ received: true });
    })().catch(() => sendResponse({ received: false }));
    return true;
  }
  if (msg.type === 'tssFioriReady') {
    const tabId = sender.tab?.id;
    if (tabId && sender.url?.startsWith('https://tss.ucsd.edu/fiori')) {
      finishReauth(tabId, true).catch(() => undefined);
    }
    sendResponse({ received: true });
    return false;
  }
  if (msg.type === 'searchClasses') {
    trackApiResult(msg.type, searchClasses(msg.term, msg.query))
      .then(sendResponse)
      .catch(() => sendResponse({ error: 'background' }));
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
    getSessionStatus()
      .then(sendResponse)
      .catch(() => sendResponse({ connected: false, error: 'background' }));
    return true;
  }
  if (msg.type === 'startReauth') {
    const flow = startReauth();
    // Reply before the sign-in window takes focus; Chrome may close an action
    // popup as soon as that browser window opens.
    sendResponse({ phase: 'pending' });
    flow.catch(() => setReauthFlow({
      phase: 'failed', strategy: 'official', error: 'background',
      detail: 'Could not start the UCSD sign-in window.',
    }).catch(() => undefined));
    return false;
  }
  if (msg.type === 'startCustomReauth') {
    if (typeof msg.username !== 'string' || typeof msg.password !== 'string'
        || !msg.username.trim() || !msg.password
        || msg.username.length > 256 || msg.password.length > 1024) {
      msg.username = '';
      msg.password = '';
      sendResponse({ phase: 'failed', error: 'credentials', detail: 'Enter a UCSD username and password.' });
      return false;
    }
    let username = msg.username.trim();
    let password = msg.password;
    msg.username = '';
    msg.password = '';
    const flow = startCustomReauth(username, password);
    username = '';
    password = '';
    flow.then(sendResponse).catch(async () => {
      await failCustomReauth('injection-failed').catch(() => undefined);
      sendResponse({ phase: 'failed', strategy: 'custom', detail: 'Could not start the custom UCSD sign-in flow.' });
    });
    return true;
  }
  return false;
});
