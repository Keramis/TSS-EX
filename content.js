// Content script on tss.ucsd.edu/fiori*: reports sign-in readiness and
// provides same-origin academic history requests.

const ACADEMIC_HISTORY_SERVICE_PATH = '/sap/opu/odata4/sap/ysb_my_achist/srvd/sap/ysd_my_achist/0001';

function reportFioriLanding() {
  // The first /fiori document can be an auto-submitting SAML request.
  if (document.querySelector('form input[name="SAMLRequest"], form input[name="SAMLResponse"]')) return;
  chrome.runtime.sendMessage({ type: 'tssFioriReady' }).catch(() => undefined);
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', reportFioriLanding, { once: true });
} else {
  reportFioriLanding();
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === 'academicHistoryContextReady' && sender.id === chrome.runtime.id) {
    sendResponse({ ready: !document.querySelector('form input[name="SAMLRequest"], form input[name="SAMLResponse"]') });
    return false;
  }
  if (message?.type !== 'fetchAcademicHistoryInPage') return false;
  if (sender.id !== chrome.runtime.id || location.origin !== 'https://tss.ucsd.edu') {
    sendResponse({ error: 'tss-context-unavailable' });
    return false;
  }

  let target;
  try {
    target = new URL(message.path, location.origin);
  } catch {
    sendResponse({ error: 'parse' });
    return false;
  }
  if (target.origin !== location.origin
      || !(target.pathname === ACADEMIC_HISTORY_SERVICE_PATH
        || target.pathname.startsWith(`${ACADEMIC_HISTORY_SERVICE_PATH}/`))) {
    sendResponse({ error: 'parse' });
    return false;
  }

  const method = String(message.method || 'GET').toUpperCase();
  if (!['GET', 'HEAD', 'POST'].includes(method)) {
    sendResponse({ error: 'parse' });
    return false;
  }
  const allowedHeaders = new Set([
    'accept', 'accept-language', 'content-type', 'mime-version',
    'odata-maxversion', 'odata-version', 'sap-passport', 'x-csrf-token',
    'x-requested-with', 'x-xhr-logon',
  ]);
  const headers = {};
  for (const [name, value] of Object.entries(message.headers || {})) {
    if (!allowedHeaders.has(name.toLowerCase())
        || typeof value !== 'string'
        || /[\r\n]/.test(value)) continue;
    headers[name] = value;
  }
  const body = method === 'POST' && typeof message.body === 'string' ? message.body : undefined;
  if (body && body.length > 256_000) {
    sendResponse({ error: 'parse' });
    return false;
  }

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 45_000);
  fetch(target.href, {
    method,
    headers,
    body,
    credentials: 'include',
    redirect: 'manual',
    signal: controller.signal,
  }).then(async (response) => {
    const text = response.type === 'opaqueredirect' ? '' : await response.text();
    sendResponse({
      status: response.status,
      ok: response.ok,
      type: response.type,
      contentType: response.headers.get('content-type'),
      text,
      csrfToken: response.headers.get('x-csrf-token'),
    });
  }).catch(() => {
    sendResponse({ error: 'network' });
  }).finally(() => {
    clearTimeout(timeoutId);
  });
  return true;
});
