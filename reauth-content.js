(() => {
  if (window.__ezplanReauthDiagnostics) return;
  const diagnostics = {
    revision: 'intercept-diagnostics-1',
    stage: 'script-loaded',
    handshake: 'not-started',
    messagingError: null,
    failure: null,
  };
  window.__ezplanReauthDiagnostics = diagnostics;
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.type !== 'probeCustomReauthHelper' || sender.id !== chrome.runtime.id) return false;
    sendResponse({ ...diagnostics, readyState: document.readyState });
    return false;
  });
  const USERNAME_FIELD = 'urn:mace:ucsd.edu:sso:username';
  const PASSWORD_FIELD = 'urn:mace:ucsd.edu:sso:password';
  const UCSD_AUTHORITY = 'entity:urn:mace:incommon:ucsd.edu';
  const CONTROL_WAIT_MS = 12000;
  let failureReported = false;

  async function sendMessage(message) {
    try {
      return await chrome.runtime.sendMessage(message);
    } catch {
      diagnostics.messagingError = `no-response:${message.type}`;
      return null;
    }
  }

  async function reportProgress(stage) {
    diagnostics.stage = stage;
    diagnostics.handshake = 'waiting';
    const response = await sendMessage({ type: 'customReauthAutomationProgress', stage });
    diagnostics.handshake = response?.accepted === true ? 'accepted' : (response?.reason || 'no-acknowledgment');
    return response?.accepted === true;
  }

  async function reportFailure(code) {
    if (failureReported) return;
    failureReported = true;
    diagnostics.failure = code;
    await sendMessage({ type: 'customReauthAutomationError', code });
  }

  function waitFor(findControl, timeoutMs = CONTROL_WAIT_MS) {
    const current = findControl();
    if (current) return Promise.resolve(current);

    return new Promise((resolve) => {
      let settled = false;
      const root = document.documentElement;
      if (!root) {
        resolve(null);
        return;
      }

      const observer = new MutationObserver(check);
      const timeoutId = window.setTimeout(() => finish(null), timeoutMs);
      function finish(value) {
        if (settled) return;
        settled = true;
        window.clearTimeout(timeoutId);
        observer.disconnect();
        resolve(value);
      }
      function check() {
        const value = findControl();
        if (value) finish(value);
      }

      observer.observe(root, { childList: true, subtree: true, attributes: true });
      check();
    });
  }

  function findUcsdSsoLink() {
    return [...document.querySelectorAll('a[href]')].find((candidate) => {
      try {
        const url = new URL(candidate.href);
        return url.origin === 'https://tssproxy.ucsd.edu'
          && url.pathname === '/idp/profile/SAML2/POST/SSO'
          && url.searchParams.get('j_authnauthority') === UCSD_AUTHORITY
          && url.searchParams.get('j_authnflow') === 'authn/SAML'
          && Boolean(url.searchParams.get('execution'))
          && Boolean(url.searchParams.get('csrf_token'))
          && url.searchParams.has('_eventId_proceed');
      } catch {
        return false;
      }
    }) || null;
  }

  function isProxyChooserPage() {
    const text = (document.body?.innerText || '').toLowerCase();
    return text.includes('triton student system login') || text.includes('ucsd sso');
  }

  function findCredentialForm() {
    for (const form of document.forms) {
      const usernameInput = form.elements.namedItem(USERNAME_FIELD);
      const passwordInput = form.elements.namedItem(PASSWORD_FIELD);
      const loginButton = [...form.elements].find((control) =>
        control instanceof HTMLButtonElement
        && control.type === 'submit'
        && control.name === '_eventId_proceed'
        && !control.matches(':disabled'));
      if (usernameInput instanceof HTMLInputElement && passwordInput instanceof HTMLInputElement && loginButton) {
        return { form, usernameInput, passwordInput, loginButton };
      }
    }
    return null;
  }

  function isA5CredentialPage() {
    const text = `${document.title || ''}\n${document.body?.innerText || ''}`.toLowerCase();
    return text.includes('single sign-on') || text.includes('sign in') || text.includes('password');
  }

  async function selectUcsdSso() {
    const link = await waitFor(findUcsdSsoLink);
    if (!link) {
      if (isProxyChooserPage()) await reportFailure('proxy-choice-not-found');
      return;
    }
    if (!await reportProgress('chooser-found')) return;
    if (window.__ezplanReauthActionStarted) return;

    // Use the live link, including this conversation's execution and CSRF state.
    // Never reconstruct, cache, or retry a previously consumed chooser URL.
    const currentLink = findUcsdSsoLink();
    if (!currentLink) {
      await reportFailure('proxy-choice-not-found');
      return;
    }
    window.__ezplanReauthActionStarted = true;
    location.assign(currentLink.href);
  }

  async function submitCredentials({ form, usernameInput, passwordInput, loginButton }) {
    if (window.__ezplanReauthActionStarted) return;
    window.__ezplanReauthActionStarted = true;

    let credentials = await sendMessage({ type: 'requestCustomReauthCredentials' });
    if (!credentials?.username || !credentials?.password) {
      await reportFailure('credentials-unavailable');
      return;
    }

    let username = credentials.username;
    let password = credentials.password;
    credentials = null;
    const submittedUrl = location.href;
    try {
      usernameInput.value = username;
      passwordInput.value = password;
      usernameInput.dispatchEvent(new Event('input', { bubbles: true }));
      usernameInput.dispatchEvent(new Event('change', { bubbles: true }));
      passwordInput.dispatchEvent(new Event('input', { bubbles: true }));
      passwordInput.dispatchEvent(new Event('change', { bubbles: true }));
      username = '';
      password = '';

      if (!await reportProgress('credentials-submitting')) return;
      if (!loginButton.isConnected || loginButton.form !== form || loginButton.matches(':disabled')) {
        await reportFailure('a5-submit-failed');
        return;
      }
      // Clicking preserves the button's _eventId_proceed field and its own
      // "Logging in" handler, as well as normal form validation/submission.
      loginButton.click();
    } catch {
      username = '';
      password = '';
      await reportFailure('a5-submit-failed');
      return;
    }

    window.setTimeout(() => {
      if (location.href !== submittedUrl || !passwordInput.isConnected) return;
      reportFailure('a5-login-not-accepted');
    }, 45000);
  }

  async function run() {
    if (!['tssproxy.ucsd.edu', 'a5.ucsd.edu'].includes(location.hostname)) return;
    if (window.__ezplanReauthHelperStarted) return;
    window.__ezplanReauthHelperStarted = true;
    // The worker acknowledges only the tab belonging to the active custom flow.
    // This keeps the globally registered document_end script inert elsewhere.
    if (!await reportProgress('helper-loaded')) return;

    if (location.hostname === 'tssproxy.ucsd.edu') {
      await selectUcsdSso();
      return;
    }

    const controls = await waitFor(findCredentialForm);
    if (!controls) {
      const hasPassword = Boolean(document.querySelector('input[type="password"]'));
      if (hasPassword) await reportFailure('a5-form-not-recognized');
      else if (isA5CredentialPage()) await reportFailure('a5-form-not-found');
      return;
    }
    if (!await reportProgress('credential-form-found')) return;
    await submitCredentials(controls);
  }

  run().catch(() => reportFailure('injection-failed'));
})();
