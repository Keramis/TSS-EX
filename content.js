// Content script on tss.ucsd.edu/fiori*: passively detects the current
// academic term from the page DOM and stores it for the popup to use.

const SEASON_MAP = { Fall: '1', Winter: '2', Spring: '3', Summer: '4' };

function detectTerm() {
  const text = document.title || document.body?.innerText || '';
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
  if (term) chrome.storage.local.set({ currentTerm: term });
}

if (document.readyState === 'complete' || document.readyState === 'interactive') {
  setTimeout(storeTerm, 500);
} else {
  window.addEventListener('DOMContentLoaded', () => setTimeout(storeTerm, 500));
}

window.addEventListener('load', () => setTimeout(storeTerm, 800));
