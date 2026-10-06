(async () => {
  const root = document.documentElement;
  try {
    const { theme } = await chrome.storage.local.get('theme');
    if (theme === 'light') root.classList.add('light-mode');
  } catch (_) {
    /* storage unavailable — stay dark (default) */
  }
})();
