// Content script on tss.ucsd.edu/fiori*: passively detects the current
// academic term from the page DOM and stores it for the popup to use.

const SEASON_MAP = { Fall: '1', Winter: '2', Spring: '3', Summer: '4' };
let lastStoredTerm = null;
let termRefreshTimer = null;

function detectTerm() {
  const text = `${document.title || ''}\n${document.body?.innerText || ''}`;
  const m = text.match(/(Fall|Winter|Spring|Summer)\s+(\d{4})/i);
  if (!m) return null;
  const season = m[1].charAt(0).toUpperCase() + m[1].slice(1).toLowerCase();
  const year = m[2];
  const period = SEASON_MAP[season];
  if (!period) return null;
  return { academicYear: year, academicPeriod: period, season };
}

function storeTerm() {
  const term = detectTerm();
  if (!term) return;
  const key = `${term.academicYear}|${term.academicPeriod}`;
  if (key === lastStoredTerm) return;
  lastStoredTerm = key;
  chrome.storage.local.set({ currentTerm: term });
}

function scheduleTermRefresh() {
  clearTimeout(termRefreshTimer);
  termRefreshTimer = setTimeout(storeTerm, 400);
}

if (document.readyState === 'complete' || document.readyState === 'interactive') scheduleTermRefresh();
else window.addEventListener('DOMContentLoaded', scheduleTermRefresh, { once: true });

window.addEventListener('load', scheduleTermRefresh);
window.addEventListener('hashchange', scheduleTermRefresh);
window.addEventListener('popstate', scheduleTermRefresh);
window.addEventListener('focus', scheduleTermRefresh);

const observer = new MutationObserver(scheduleTermRefresh);
observer.observe(document.documentElement, { childList: true, characterData: true, subtree: true });
