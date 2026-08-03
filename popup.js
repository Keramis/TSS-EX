const START_HOUR = 7;
const END_HOUR = 21;
const HOUR_HEIGHT = 60;
const DAYS = ['M', 'Tu', 'W', 'Th', 'F'];
const DEFAULT_TERM = { academicYear: '2026', academicPeriod: '2' };
const PERIOD_CODE = { '1': 'FA', '2': 'WI', '3': 'SP', '4': 'SU' };

let planned = [];
let currentTerm = null;
let showFinals = false;

// ---------- Storage helpers ----------
async function loadPlanned() {
  const { plannedClasses } = await chrome.storage.local.get('plannedClasses');
  return Array.isArray(plannedClasses) ? plannedClasses : [];
}

function savePlanned() {
  return chrome.storage.local.set({ plannedClasses: planned });
}

async function loadTerm() {
  const { currentTerm: t } = await chrome.storage.local.get('currentTerm');
  currentTerm = t || DEFAULT_TERM;
  return currentTerm;
}

function termBadge(term) {
  const code = PERIOD_CODE[term.academicPeriod] || '?';
  const yr = String(term.academicYear).slice(-2);
  return `${code}${yr}`;
}

// ---------- Time / schedule parsing ----------
function timeToMinutes(t) {
  const [h, m] = t.split(':').map(Number);
  return h * 60 + m;
}

function minutesToLabel(mins) {
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  const ampm = h >= 12 ? 'PM' : 'AM';
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${h12}:${m.toString().padStart(2, '0')} ${ampm}`;
}

function to24h(t) {
  const m = t.trim().match(/^(\d{1,2}):(\d{2})\s*(AM|PM)$/i);
  if (!m) return t.trim();
  let h = parseInt(m[1], 10);
  const min = m[2];
  const ap = m[3].toUpperCase();
  if (ap === 'PM' && h !== 12) h += 12;
  if (ap === 'AM' && h === 12) h = 0;
  return `${h.toString().padStart(2, '0')}:${min}`;
}

function normalizeDay(d) {
  const lower = d.toLowerCase();
  if (lower === 'tu') return 'Tu';
  if (lower === 'th') return 'Th';
  if (lower === 'sa') return 'Sa';
  if (lower === 'su') return 'Su';
  return d.charAt(0).toUpperCase();
}

function parseSched(sched, type) {
  const blocks = [];
  if (!sched) return blocks;
  for (const line of sched.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const isFinal = /^final\s+examination/i.test(trimmed);
    if (isFinal && !showFinals) continue;
    // Finals have a date prefix: "Final Examination 12/09/2026 08:00 AM - 10:59 AM In Person @ ..."
    let m = trimmed.match(
      /^([A-Za-z]{1,2}(?:,\s*[A-Za-z]{1,2})*)\s+(\d{1,2}:\d{2}\s*[AP]M)\s*-\s*(\d{1,2}:\d{2}\s*[AP]M)\s+In\s+Person\s+@\s+(.+)$/i
    );
    if (!m && isFinal) {
      m = trimmed.match(
        /^Final\s+Examination\s+\d{1,2}\/\d{1,2}\/\d{4}\s+(\d{1,2}:\d{2}\s*[AP]M)\s*-\s*(\d{1,2}:\d{2}\s*[AP]M)\s+In\s+Person\s+@\s+(.+)$/i
      );
      if (m) {
        // Finals don't have a day-of-week in the Sched string; use a synthetic day 'Final'.
        blocks.push({
          day: 'Final',
          start: to24h(m[1]),
          end: to24h(m[2]),
          location: m[3].trim(),
          type: 'FINAL',
          isFinal: true,
        });
      }
      continue;
    }
    if (!m) continue;
    const days = m[1].split(',').map((d) => d.trim()).filter(Boolean);
    const start = to24h(m[2]);
    const end = to24h(m[3]);
    const location = m[4].trim();
    for (const d of days) blocks.push({ day: normalizeDay(d), start, end, location, type });
  }
  return blocks;
}

// ---------- Section grouping ----------
function groupSections(sections) {
  const map = {};
  for (const s of sections) {
    const key = s.EventPkgOtjid;
    if (!map[key]) {
      map[key] = {
        otjid: key,
        objid: s.EventPkgObjid,
        displayID: s.EventPkgDisplayID,
        pkgText: s.EventPkgText || '',
        methods: [],
        raw: [],
        scheduleBlocks: [],
        seatsAvailable: parseInt(s.EventPkgSeatsAvailable, 10) || 0,
        seatsTotal: parseInt(s.EventPkgLimit, 10) || 0,
        instructor: s.InstructorName || 'Staff',
      };
    }
    map[key].raw.push(s);
    if (!map[key].methods.includes(s.TeachingMethod)) map[key].methods.push(s.TeachingMethod);
  }
  for (const key in map) {
    const pkg = map[key];
    pkg.scheduleBlocks = [];
    for (const s of pkg.raw) {
      pkg.scheduleBlocks.push(...parseSched(s.Sched, s.TeachingMethod));
    }
  }
  return Object.values(map).sort((a, b) => String(a.displayID).localeCompare(String(b.displayID)));
}

// ---------- Conflict detection ----------
// Returns { conflictBlockKeys: Set, finalConflictClassIds: Set }
// conflictBlockKeys: "classId|day|start|end" keys for blocks that overlap a non-final block
// finalConflictClassIds: class IDs that have a final-exam overlap with another class's final
function detectConflicts(classes) {
  const conflictBlockKeys = new Set();
  const finalConflictClassIds = new Set();

  const regularBlocks = [];
  const finalBlocks = [];
  for (const cls of classes) {
    for (const b of cls.scheduleBlocks) {
      const entry = { ...b, classId: cls.id, courseAbbr: cls.courseAbbr };
      const key = `${cls.id}|${b.day}|${b.start}|${b.end}`;
      if (b.isFinal) finalBlocks.push({ ...entry, key });
      else regularBlocks.push({ ...entry, key });
    }
  }

  // Regular conflicts: same day + overlapping time
  for (let i = 0; i < regularBlocks.length; i++) {
    for (let j = i + 1; j < regularBlocks.length; j++) {
      const a = regularBlocks[i], b = regularBlocks[j];
      if (a.day !== b.day) continue;
      const aS = timeToMinutes(a.start), aE = timeToMinutes(a.end);
      const bS = timeToMinutes(b.start), bE = timeToMinutes(b.end);
      if (aS < bE && aE > bS) {
        conflictBlockKeys.add(a.key);
        conflictBlockKeys.add(b.key);
      }
    }
  }

  // Final conflicts: two finals overlap in time (day is synthetic 'Final', so compare by time only)
  for (let i = 0; i < finalBlocks.length; i++) {
    for (let j = i + 1; j < finalBlocks.length; j++) {
      const a = finalBlocks[i], b = finalBlocks[j];
      if (a.classId === b.classId) continue;
      const aS = timeToMinutes(a.start), aE = timeToMinutes(a.end);
      const bS = timeToMinutes(b.start), bE = timeToMinutes(b.end);
      if (aS < bE && aE > bS) {
        finalConflictClassIds.add(a.classId);
        finalConflictClassIds.add(b.classId);
      }
    }
  }

  return { conflictBlockKeys, finalConflictClassIds };
}

// ---------- Calendar ----------
function buildTimeAxis() {
  const axis = document.getElementById('time-axis');
  axis.innerHTML = '';
  for (let h = START_HOUR; h <= END_HOUR; h++) {
    const label = document.createElement('div');
    label.className = 'time-label';
    const ampm = h >= 12 ? 'PM' : 'AM';
    const h12 = h % 12 === 0 ? 12 : h % 12;
    label.textContent = `${h12}:00 ${ampm}`;
    const top = (h - START_HOUR) * HOUR_HEIGHT;
    label.style.top = `${top}px`;
    axis.appendChild(label);
  }
  axis.style.height = `${(END_HOUR - START_HOUR) * HOUR_HEIGHT}px`;
}

function renderCalendar() {
  for (const day of DAYS) {
    const col = document.querySelector(`.day-col[data-day="${day}"] .day-body`);
    col.innerHTML = '';
    col.style.height = `${(END_HOUR - START_HOUR) * HOUR_HEIGHT}px`;
  }
  const { conflictBlockKeys, finalConflictClassIds } = detectConflicts(planned);
  for (const cls of planned) {
    const isFinalConflict = finalConflictClassIds.has(cls.id);
    for (const b of cls.scheduleBlocks) {
      if (b.isFinal) continue; // finals not rendered on weekly grid
      const col = document.querySelector(`.day-col[data-day="${b.day}"] .day-body`);
      if (!col) continue;
      const startMin = timeToMinutes(b.start) - START_HOUR * 60;
      const endMin = timeToMinutes(b.end) - START_HOUR * 60;
      const top = (startMin / 60) * HOUR_HEIGHT;
      const height = Math.max(((endMin - startMin) / 60) * HOUR_HEIGHT, 18);
      const key = `${cls.id}|${b.day}|${b.start}|${b.end}`;
      const isConflict = conflictBlockKeys.has(key);
      const block = document.createElement('div');
      block.className = `block ${b.type.toLowerCase()}${isConflict ? ' conflict' : ''}`;
      block.style.top = `${top}px`;
      block.style.height = `${height}px`;
      const conflictNote = isConflict ? '\n⚠ Schedule overlap' : '';
      const finalNote = isFinalConflict ? '\n⚠ Final exam conflict' : '';
      block.title = `${cls.courseAbbr} ${b.type}\n${minutesToLabel(timeToMinutes(b.start))} - ${minutesToLabel(timeToMinutes(b.end))}\n${b.location}${conflictNote}${finalNote}`;
      block.innerHTML = `<div class="block-title">${cls.courseAbbr}</div><div class="block-time">${b.start}-${b.end}</div><div class="block-loc">${b.location}</div>`;
      col.appendChild(block);
    }
  }
}

// ---------- Planned list ----------
function seatsClass(avail, total) {
  if (avail <= 0) return 'seats-full';
  if (avail <= total * 0.15) return 'seats-low';
  return 'seats-ok';
}

function tssLink(cls) {
  return (
    `https://tss.ucsd.edu/fiori#ZUSModule-display?TileType=MYMOD&/Detail/EventPackage/SM/` +
    `${cls.moduleID}/00000000/0/0/0/00000000-0000-0000-0000-000000000000/` +
    `${cls.eventPkgObjid}/${cls.academicYear}/${cls.academicPeriod}/?`
  );
}

function renderPlannedList() {
  const list = document.getElementById('planned-list');
  const empty = document.getElementById('planned-empty');
  const count = document.getElementById('planned-count');
  list.innerHTML = '';
  count.textContent = planned.length;
  if (planned.length === 0) {
    empty.classList.remove('hidden');
    return;
  }
  empty.classList.add('hidden');
  const { conflictBlockKeys, finalConflictClassIds } = detectConflicts(planned);
  for (const cls of planned) {
    const hasScheduleConflict = cls.scheduleBlocks.some(
      (b) => !b.isFinal && conflictBlockKeys.has(`${cls.id}|${b.day}|${b.start}|${b.end}`)
    );
    const hasFinalConflict = finalConflictClassIds.has(cls.id);
    const card = document.createElement('div');
    let cardClass = 'planned-card';
    if (hasFinalConflict) cardClass += ' final-conflict-card';
    else if (hasScheduleConflict) cardClass += ' conflict-card';
    card.className = cardClass;

    const scheduleTags = cls.scheduleBlocks
      .map((b) => {
        const key = `${cls.id}|${b.day}|${b.start}|${b.end}`;
        const isBlockConflict = !b.isFinal && conflictBlockKeys.has(key);
        return `<span class="schedule-tag ${b.type.toLowerCase()}${isBlockConflict ? ' tag-conflict' : ''}">${b.day} ${b.start}-${b.end}</span>`;
      })
      .join('');

    const seatsCls = seatsClass(cls.seatsAvailable, cls.seatsTotal);

    let conflictNote = '';
    if (hasFinalConflict) {
      conflictNote = '<div class="conflict-note conflict-final">⚠ Final exam conflict detected</div>';
    } else if (hasScheduleConflict) {
      conflictNote = '<div class="conflict-note conflict-schedule">⚠ Schedule overlap on some sections</div>';
    }

    card.innerHTML = `
      <div class="planned-card-head">
        <div class="planned-card-title">
          <span class="planned-card-abbr">${cls.courseAbbr}</span>
          <span class="planned-card-name">${cls.courseTitle}</span>
        </div>
        <div class="planned-card-actions">
          <button class="btn btn-small btn-primary js-open" data-id="${cls.id}">Open in TSS</button>
          <button class="btn-danger-text js-remove" data-id="${cls.id}" title="Remove">&times;</button>
        </div>
      </div>
      <div class="planned-card-body">
        <div class="planned-schedule">${scheduleTags}</div>
        <div class="planned-info">
          <span class="planned-info-label">Seats:</span>
          <span class="${seatsCls}">${cls.seatsAvailable}/${cls.seatsTotal}</span>
        </div>
        <div class="planned-info">
          <span class="planned-info-label">Instructor:</span>
          <span>${cls.instructor}</span>
        </div>
        <div class="planned-info">
          <span class="planned-info-label">Credits:</span>
          <span>${cls.credits}</span>
        </div>
        ${conflictNote}
      </div>
    `;
    list.appendChild(card);
  }
  list.querySelectorAll('.js-remove').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      const id = e.currentTarget.dataset.id;
      planned = planned.filter((c) => c.id !== id);
      savePlanned().then(renderAll);
    });
  });
  list.querySelectorAll('.js-open').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      const id = e.currentTarget.dataset.id;
      const cls = planned.find((c) => c.id === id);
      if (cls) chrome.tabs.create({ url: tssLink(cls) });
    });
  });
}

function renderAll() {
  renderCalendar();
  renderPlannedList();
}

// ---------- Auth banner ----------
function showAuthBanner(mode, extra) {
  const banner = document.getElementById('auth-banner');
  const text = document.getElementById('auth-text');
  banner.classList.remove('hidden', 'danger');
  if (mode === 'expired') {
    banner.classList.add('danger');
    text.innerHTML =
      'Your TSS session has expired. Searching for classes is unavailable until you ' +
      '<a href="https://tss.ucsd.edu/fiori" target="_blank">log into TSS</a> again. ' +
      'Your planned classes are preserved.';
  } else if (mode === 'not-connected') {
    text.innerHTML =
      'Not connected to TSS. Open <a href="https://tss.ucsd.edu/fiori" target="_blank">TSS</a> ' +
      'and log in to capture your session — your planned classes are kept.';
  } else {
    banner.classList.add('danger');
    text.textContent = `Search failed: ${extra || 'unknown error'}. Log into TSS and try again.`;
  }
}

function hideAuthBanner() {
  document.getElementById('auth-banner').classList.add('hidden');
}

// ---------- Search results ----------
function showSearchResults(show) {
  const el = document.getElementById('search-results');
  if (show) el.classList.remove('hidden');
  else el.classList.add('hidden');
}

function renderSearchResults(results) {
  const list = document.getElementById('results-list');
  const count = document.getElementById('results-count');
  list.innerHTML = '';
  count.textContent = results.length;
  if (results.length === 0) {
    const empty = document.createElement('li');
    empty.className = 'results-empty';
    empty.textContent = 'No classes found. Try a different query (e.g. PHYS 002C).';
    list.appendChild(empty);
  } else {
    for (const r of results) {
      const li = document.createElement('li');
      li.className = 'result-item';
      li.innerHTML = `
        <div class="result-main">
          <span class="result-abbr">${r.courseAbbr}</span>
          <span class="result-title">${r.courseTitle}</span>
        </div>
        <div class="result-meta">
          <span class="chip">${r.credits} cr</span>
          <span class="chip chip-dept">${r.departmentAbbr}</span>
        </div>`;
      li.addEventListener('click', () => onResultClick(r));
      list.appendChild(li);
    }
  }
  showSearchResults(true);
}

function renderSearchLoading() {
  const list = document.getElementById('results-list');
  const count = document.getElementById('results-count');
  list.innerHTML = '';
  count.textContent = '…';
  const loading = document.createElement('li');
  loading.className = 'results-loading';
  loading.textContent = 'Searching…';
  list.appendChild(loading);
  showSearchResults(true);
}

async function doSearch() {
  const input = document.getElementById('search-input');
  const q = input.value.trim();
  if (!q) {
    showSearchResults(false);
    return;
  }
  await loadTerm();
  renderSearchLoading();
  let resp;
  try {
    resp = await chrome.runtime.sendMessage({ type: 'searchClasses', term: currentTerm, query: q });
  } catch (e) {
    showAuthBanner('error', e.message);
    showSearchResults(false);
    return;
  }
  if (!resp) {
    showAuthBanner('error', 'no response from background');
    showSearchResults(false);
    return;
  }
  if (resp.error === 'no-auth' || resp.error === 'auth-expired') {
    showAuthBanner('expired');
    showSearchResults(false);
    return;
  }
  if (resp.error) {
    showAuthBanner('error', `${resp.error}${resp.status ? ` (${resp.status})` : ''}`);
    showSearchResults(false);
    return;
  }
  hideAuthBanner();
  renderSearchResults(resp.results || []);
}

async function onResultClick(course) {
  const term = currentTerm || (await loadTerm());
  let resp;
  try {
    resp = await chrome.runtime.sendMessage({ type: 'getSections', moduleID: course.moduleID, term });
  } catch (e) {
    showAuthBanner('error', e.message);
    return;
  }
  if (resp.error === 'no-auth' || resp.error === 'auth-expired') {
    showAuthBanner('expired');
    return;
  }
  if (resp.error) {
    showAuthBanner('error', `${resp.error}${resp.status ? ` (${resp.status})` : ''}`);
    return;
  }
  hideAuthBanner();
  const packages = groupSections(resp.sections || []);
  openSectionPicker(course, packages, term);
}

// ---------- Section picker modal ----------
function openSectionPicker(course, packages, term) {
  const backdrop = document.createElement('div');
  backdrop.className = 'modal-backdrop';

  if (packages.length === 0) {
    backdrop.innerHTML = `
      <div class="modal">
        <div class="modal-head">
          <div class="modal-title">${course.courseAbbr} — No sections</div>
          <button class="modal-close">&times;</button>
        </div>
        <div class="modal-body">
          <div class="results-empty">No sections are available for this course in the current term.</div>
        </div>
        <div class="modal-foot">
          <button class="btn js-modal-cancel">Close</button>
        </div>
      </div>`;
    document.body.appendChild(backdrop);
    const close = () => backdrop.remove();
    backdrop.querySelector('.modal-close').addEventListener('click', close);
    backdrop.querySelector('.js-modal-cancel').addEventListener('click', close);
    backdrop.addEventListener('click', (e) => { if (e.target === backdrop) close(); });
    return;
  }

  const optionsHtml = packages
    .map((pkg, i) => {
      const methodTags = pkg.methods
        .map((m) => `<span class="method-tag ${m.toLowerCase()}">${m}</span>`)
        .join('');
      const detailLines = pkg.scheduleBlocks
        .map((b) => `<span>${b.day} ${b.start}-${b.end} — ${b.location} (${b.type})</span>`)
        .join('');
      const seatsCls = seatsClass(pkg.seatsAvailable, pkg.seatsTotal);
      return `
        <div class="package-option" data-idx="${i}">
          <div class="package-head">
            <span class="package-id">${pkg.displayID || pkg.otjid} — ${pkg.pkgText}</span>
            <div class="package-methods">${methodTags}</div>
          </div>
          <div class="package-detail">
            ${detailLines}
            <span>Seats: <span class="${seatsCls}">${pkg.seatsAvailable}/${pkg.seatsTotal}</span> · ${pkg.instructor}</span>
          </div>
        </div>`;
    })
    .join('');

  backdrop.innerHTML = `
    <div class="modal">
      <div class="modal-head">
        <div class="modal-title">${course.courseAbbr} — Choose a Section</div>
        <button class="modal-close">&times;</button>
      </div>
      <div class="modal-body">${optionsHtml}</div>
      <div class="modal-foot">
        <button class="btn js-modal-cancel">Cancel</button>
        <button class="btn btn-primary js-modal-add">Add to Plan</button>
      </div>
    </div>`;
  document.body.appendChild(backdrop);

  let selectedIdx = null;
  backdrop.querySelectorAll('.package-option').forEach((opt) => {
    opt.addEventListener('click', () => {
      backdrop.querySelectorAll('.package-option').forEach((o) => o.classList.remove('selected'));
      opt.classList.add('selected');
      selectedIdx = parseInt(opt.dataset.idx, 10);
    });
  });

  const close = () => backdrop.remove();
  backdrop.querySelector('.modal-close').addEventListener('click', close);
  backdrop.querySelector('.js-modal-cancel').addEventListener('click', close);
  backdrop.addEventListener('click', (e) => { if (e.target === backdrop) close(); });

  backdrop.querySelector('.js-modal-add').addEventListener('click', () => {
    if (selectedIdx === null) {
      alert('Please select a section package.');
      return;
    }
    const pkg = packages[selectedIdx];
    const plannedClass = {
      id: 'p-' + Date.now() + '-' + Math.random().toString(36).slice(2, 7),
      moduleID: course.moduleID,
      courseAbbr: course.courseAbbr,
      courseTitle: course.courseTitle,
      credits: course.credits,
      academicYear: course.academicYear || term.academicYear,
      academicPeriod: course.academicPeriod || term.academicPeriod,
      departmentAbbr: course.departmentAbbr,
      selectedPackageOtjid: pkg.otjid,
      eventPkgObjid: pkg.objid,
      seatsAvailable: pkg.seatsAvailable,
      seatsTotal: pkg.seatsTotal,
      instructor: pkg.instructor,
      scheduleBlocks: pkg.scheduleBlocks,
      _lastPkg: pkg,
      addedAt: Date.now(),
    };
    planned.push(plannedClass);
    savePlanned().then(renderAll);
    close();
  });
}

// ---------- Init ----------
async function checkAuth() {
  const { auth } = await chrome.runtime.sendMessage({ type: 'getAuth' });
  if (!auth || (!auth.cookie && !auth.csrfToken && !auth.sapPassport)) {
    showAuthBanner('not-connected');
  } else {
    hideAuthBanner();
  }
}

document.addEventListener('DOMContentLoaded', async () => {
  buildTimeAxis();
  planned = await loadPlanned();
  await loadTerm();
  document.getElementById('term-badge').textContent = termBadge(currentTerm);
  renderAll();
  checkAuth();

  const input = document.getElementById('search-input');
  const searchBtn = document.getElementById('search-btn');
  searchBtn.addEventListener('click', doSearch);
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') doSearch(); });

  const showFinalsEl = document.getElementById('show-finals');
  const { settings } = await chrome.storage.local.get('settings');
  showFinals = settings?.showFinals || false;
  showFinalsEl.checked = showFinals;
  showFinalsEl.addEventListener('change', async () => {
    showFinals = showFinalsEl.checked;
    await chrome.storage.local.set({ settings: { ...(settings || {}), showFinals } });
    // Re-parse schedule blocks for all planned classes to include/exclude finals
    for (const cls of planned) {
      const pkg = cls._lastPkg;
      if (!pkg) continue;
      cls.scheduleBlocks = [];
      for (const s of pkg.raw) cls.scheduleBlocks.push(...parseSched(s.Sched, s.TeachingMethod));
    }
    renderAll();
  });
});
