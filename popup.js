const DAYS = ['M', 'Tu', 'W', 'Th', 'F', 'Sa', 'Su'];
const DEFAULT_TERM = { academicYear: '2026', academicPeriod: '2' };
const PERIOD_CODE = { '1': 'FA', '2': 'WI', '3': 'SP', '4': 'SU' };

let planned = [];
let currentTerm = null;
const showFinals = true;
let isPlanner = false;
let selectedDetailId = null;
let authCheckSequence = 0;
let activeRefreshId = null;
let fullRefreshStarting = false;
let observedRefreshId = null;
let refreshStopRequested = false;
const singleClassRefreshes = new Map();
let singleRefreshQueue = Promise.resolve();
let personalRefreshPromise = null;
let scheduleSyncActive = false;

function sendRuntimeMessage(message, timeoutMs = 20000) {
  let timeoutId;
  const timeout = new Promise((_, reject) => {
    timeoutId = setTimeout(() => reject(new Error('No response from the background worker. Reload the extension and try again.')), timeoutMs);
  });
  const request = Promise.resolve().then(() => chrome.runtime.sendMessage(message));
  return Promise.race([request, timeout]).finally(() => clearTimeout(timeoutId));
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (char) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[char]);
}

function profileNameParts(personalDetails) {
  const rawName = String(personalDetails?.name || '').trim();
  const match = rawName.match(/\s*\(([^()]*(?:\/)[^()]*)\)\s*$/);
  return {
    displayName: (match ? rawName.slice(0, match.index) : rawName).trim() || 'My profile',
    pronouns: match ? match[1].trim() : '',
  };
}

function renderPersonalProfile(personalDetails) {
  const button = document.getElementById('profile-toggle');
  const name = document.getElementById('profile-name');
  const body = document.getElementById('profile-details');
  if (!button || !name || !body) return;
  const parts = profileNameParts(personalDetails);
  name.textContent = parts.displayName;
  button.title = parts.displayName === 'My profile' ? 'Student profile' : `Student profile for ${parts.displayName}`;
  if (!personalDetails) {
    body.innerHTML = '<p class="profile-empty">Sign in to TSS to load your personal information.</p>';
    return;
  }
  const address = personalDetails.address || {};
  const addressLines = [address.careOf ? `c/o ${address.careOf}` : '', address.line1, address.line2, address.country].filter(Boolean);
  const validTo = /9999\s*$/.test(personalDetails.validTo || '') ? 'No expiry' : personalDetails.validTo;
  const rows = [
    ['Pronouns', parts.pronouns || 'Not provided'],
    ['TSN', personalDetails.studentNumber],
    ['Email', personalDetails.email],
    ['Address', addressLines.length ? addressLines.join('<br>') : 'Not provided'],
    ['Valid from', personalDetails.validFrom],
    ['Valid to', validTo],
  ].filter(([, value]) => Boolean(value));
  body.innerHTML = rows.map(([label, value]) => `
    <div class="profile-detail-row">
      <span>${escapeHtml(label)}</span>
      <strong>${label === 'Address' ? addressLines.map(escapeHtml).join('<br>') : escapeHtml(value)}</strong>
    </div>`).join('');
}

async function refreshPersonalDetails(force = false) {
  if (personalRefreshPromise) return personalRefreshPromise;
  personalRefreshPromise = (async () => {
    const { personalDetails } = await chrome.storage.local.get('personalDetails');
    renderPersonalProfile(personalDetails || null);
    if (!force && personalDetails?.fetchedAt && Date.now() - personalDetails.fetchedAt < 30 * 60 * 1000) return personalDetails;
    let response;
    try {
      response = await sendRuntimeMessage({ type: 'getPersonalDetails' });
    } catch {
      return personalDetails || null;
    }
    if (!response?.personalDetails) return personalDetails || null;
    const next = { ...response.personalDetails, fetchedAt: Date.now() };
    await chrome.storage.local.set({ personalDetails: next });
    renderPersonalProfile(next);
    return next;
  })().finally(() => { personalRefreshPromise = null; });
  return personalRefreshPromise;
}

// ---------- Storage helpers ----------
async function loadPlanned() {
  const { plannedClasses } = await chrome.storage.local.get('plannedClasses');
  return Array.isArray(plannedClasses) ? plannedClasses.map((cls) => {
    if (!cls._lastPkg?.raw) return cls;
    const refreshedSchedule = cls._lastPkg.raw.flatMap((section) => parseSched(section.Sched, section.TeachingMethod));
    return {
      ...cls,
      scheduleBlocks: refreshedSchedule,
      waitlistTotal: cls.waitlistTotal ?? (Number.parseInt(cls._lastPkg.raw[0]?.EventPkgNumOnWaitl, 10) || 0),
    };
  }) : [];
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

function meetingTypeClass(type) {
  const normalized = String(type || '').trim().toUpperCase();
  if (normalized === 'LE' || normalized === 'L' || normalized.includes('LECTURE')) return 'le';
  if (normalized === 'DI' || normalized.includes('DISCUSSION')) return 'di';
  if (normalized === 'LA' || normalized === 'LB' || normalized === 'LAB' || normalized.includes('LAB')) return 'lab';
  return 'other';
}

function parseSched(sched, type) {
  const blocks = [];
  if (!sched) return blocks;
  for (const line of sched.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const isFinal = /^final\s+examination/i.test(trimmed);
    // Finals have a date prefix: "Final Examination 12/09/2026 08:00 AM - 10:59 AM In Person @ ..."
    let m = trimmed.match(
      /^([A-Za-z]{1,2}(?:,\s*[A-Za-z]{1,2})*)\s+(\d{1,2}:\d{2}\s*[AP]M)\s*-\s*(\d{1,2}:\d{2}\s*[AP]M)(?:\s+(?:(?:In\s+Person|Online|Remote|Hybrid)\s*@\s*)?(.+))?$/i
    );
    if (!m && isFinal) {
      m = trimmed.match(
        /^Final\s+Examination\s+(\d{1,2}\/\d{1,2}\/\d{4})\s+(\d{1,2}:\d{2}\s*[AP]M)\s*-\s*(\d{1,2}:\d{2}\s*[AP]M)(?:\s+(?:(?:In\s+Person|Online|Remote|Hybrid)\s*@\s*)?(.+))?$/i
      );
      if (m) {
        // The final date is stored separately and converted to a weekday for display.
        blocks.push({
          day: 'Final',
          finalDate: m[1],
          start: to24h(m[2]),
          end: to24h(m[3]),
          location: (m[4] || 'Location unavailable').trim(),
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
    const location = (m[4] || 'Location unavailable').trim();
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
        seatsAvailable: Number.parseInt(s.EventPkgSeatsAvailable, 10) || 0,
        seatsTotal: parseInt(s.EventPkgLimit, 10) || 0,
        waitlistTotal: Number.parseInt(s.EventPkgNumOnWaitl, 10) || 0,
        instructor: s.InstructorName || 'Staff',
        status: s.EventPkgStatusText || s.Status || 'Unknown',
        location: s.locationText || '',
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

  // Final conflicts: two finals overlap in time AND occur on the same date
  for (let i = 0; i < finalBlocks.length; i++) {
    for (let j = i + 1; j < finalBlocks.length; j++) {
      const a = finalBlocks[i], b = finalBlocks[j];
      if (a.classId === b.classId) continue;
      if (a.finalDate !== b.finalDate) continue;
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
function calendarLayout() {
  const allBlocks = planned.flatMap((cls) => (cls.scheduleBlocks || []).filter((b) => !b.isFinal));
  if (!allBlocks.length) return { start: 8, end: 17, hourHeight: isPlanner ? 50 : 34 };
  if (isPlanner) {
    const min = Math.min(...allBlocks.map((b) => timeToMinutes(b.start)));
    const max = Math.max(...allBlocks.map((b) => timeToMinutes(b.end)));
    return { start: Math.min(7, Math.floor(min / 60)), end: Math.max(21, Math.ceil(max / 60)), hourHeight: 50 };
  }
  const min = Math.min(...allBlocks.map((b) => timeToMinutes(b.start)));
  const max = Math.max(...allBlocks.map((b) => timeToMinutes(b.end)));
  const start = Math.floor(min / 60);
  const end = Math.ceil(max / 60) || start + 1;
  return { start, end: Math.max(end, start + 1), hourHeight: Math.min(34, 315 / Math.max(1, end - start)) };
}

function assignOverlapLanes(entries) {
  const sorted = [...entries].sort((a, b) => timeToMinutes(a.block.start) - timeToMinutes(b.block.start));
  const laidOut = [];
  let cluster = [];
  let clusterEnd = -1;
  const finishCluster = () => {
    if (!cluster.length) return;
    const laneEnds = [];
    for (const entry of cluster) {
      const start = timeToMinutes(entry.block.start);
      const end = timeToMinutes(entry.block.end);
      let lane = laneEnds.findIndex((endAt) => endAt <= start);
      if (lane < 0) lane = laneEnds.length;
      laneEnds[lane] = end;
      entry.lane = lane;
    }
    for (const entry of cluster) entry.laneCount = laneEnds.length;
    laidOut.push(...cluster);
    cluster = [];
    clusterEnd = -1;
  };
  for (const entry of sorted) {
    const start = timeToMinutes(entry.block.start);
    if (cluster.length && start >= clusterEnd) finishCluster();
    cluster.push(entry);
    clusterEnd = Math.max(clusterEnd, timeToMinutes(entry.block.end));
  }
  finishCluster();
  return laidOut;
}

function buildTimeAxis(layout) {
  const axis = document.getElementById('time-axis');
  axis.innerHTML = '';
  const span = layout.end - layout.start;
  const step = isPlanner ? 1 : Math.max(1, Math.ceil(span / 5));
  for (let h = layout.start; h <= layout.end; h += step) {
    const label = document.createElement('div');
    label.className = 'time-label';
    const ampm = h >= 12 ? 'PM' : 'AM';
    const h12 = h % 12 === 0 ? 12 : h % 12;
    label.textContent = `${h12}:00 ${ampm}`;
    const top = (h - layout.start) * layout.hourHeight;
    label.style.top = `${top + 26}px`;
    axis.appendChild(label);
  }
  axis.style.height = `${span * layout.hourHeight + 26}px`;
}

function renderCalendar() {
  const layout = calendarLayout();
  buildTimeAxis(layout);
  for (const day of DAYS) {
    const col = document.querySelector(`.day-col[data-day="${day}"] .day-body`);
    if (!col) continue;
    col.innerHTML = '';
    col.style.height = `${(layout.end - layout.start) * layout.hourHeight}px`;
    col.style.setProperty('--hour-height', `${layout.hourHeight}px`);
  }
  const { conflictBlockKeys, finalConflictClassIds } = detectConflicts(planned);
  const laneByBlock = new Map();
  for (const day of DAYS) {
    const entries = planned.flatMap((cls) => (cls.scheduleBlocks || [])
      .filter((block) => !block.isFinal && block.day === day)
      .map((block) => ({ cls, block })));
    for (const entry of assignOverlapLanes(entries)) laneByBlock.set(entry.block, entry);
  }
  for (const cls of planned) {
    const isFinalConflict = finalConflictClassIds.has(cls.id);
    for (const b of cls.scheduleBlocks) {
      if (b.isFinal) continue; // finals not rendered on weekly grid
      const col = document.querySelector(`.day-col[data-day="${b.day}"] .day-body`);
      if (!col) continue;
      const startMin = timeToMinutes(b.start) - layout.start * 60;
      const endMin = timeToMinutes(b.end) - layout.start * 60;
      const top = (startMin / 60) * layout.hourHeight;
      const height = Math.max(((endMin - startMin) / 60) * layout.hourHeight, isPlanner ? 22 : 8);
      const key = `${cls.id}|${b.day}|${b.start}|${b.end}`;
      const isConflict = conflictBlockKeys.has(key);
      const lane = laneByBlock.get(b) || { lane: 0, laneCount: 1 };
      const block = document.createElement('div');
      block.className = `block ${meetingTypeClass(b.type || 'LE')}${cls.registered ? ' registered' : ' not-booked'}${isConflict ? ' conflict' : ''}${lane.laneCount > 1 ? ' overlap-lane' : ''}`;
      block.style.top = `${top}px`;
      block.style.height = `${height}px`;
      block.style.left = `calc(${lane.lane * 100 / lane.laneCount}% + 2px)`;
      block.style.width = `calc(${100 / lane.laneCount}% - 4px)`;
      block.style.right = 'auto';
      const conflictNote = isConflict ? '\n⚠ Schedule overlap' : '';
      const finalNote = isFinalConflict ? '\n⚠ Final exam conflict' : '';
      block.title = `${cls.courseAbbr} ${b.type}\n${minutesToLabel(timeToMinutes(b.start))} - ${minutesToLabel(timeToMinutes(b.end))}\n${b.location}${conflictNote}${finalNote}`;
      const title = document.createElement('div');
      title.className = 'block-title';
      title.textContent = cls.courseAbbr;
      block.appendChild(title);
      if (isPlanner) {
        const time = document.createElement('div');
        time.className = 'block-time';
        time.textContent = `${minutesToLabel(timeToMinutes(b.start))}–${minutesToLabel(timeToMinutes(b.end))}`;
        const room = document.createElement('div');
        room.className = 'block-loc';
        room.textContent = `${roomLabel(b.location)} · ${cls.instructor || 'Staff'}`;
        block.append(time, room);
      }
      block.tabIndex = 0;
      block.setAttribute('role', 'button');
      block.setAttribute('aria-label', `${cls.courseAbbr}, ${minutesToLabel(timeToMinutes(b.start))} to ${minutesToLabel(timeToMinutes(b.end))}`);
      block.addEventListener('click', () => openScheduleQuicklook(cls, b));
      block.addEventListener('keydown', (event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          openScheduleQuicklook(cls, b);
        }
      });
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

function dateFromFinal(value) {
  const match = String(value || '').match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  return match ? new Date(Number(match[3]), Number(match[1]) - 1, Number(match[2]), 12) : null;
}

function finalDateLabel(block) {
  const date = dateFromFinal(block.finalDate);
  if (!date) return block.finalDate || 'Date unavailable';
  return new Intl.DateTimeFormat('en-US', {
    weekday: 'short', month: 'short', day: 'numeric', year: 'numeric',
  }).format(date);
}

function finalTimeLabel(block) {
  return `${minutesToLabel(timeToMinutes(block.start))}–${minutesToLabel(timeToMinutes(block.end))}`;
}

function roomLabel(location) {
  const match = String(location || '').match(/\bRoom\s+([\w-]+)/i);
  return match ? `Room ${match[1]}` : String(location || 'Room unavailable');
}

function openScheduleQuicklook(cls, block) {
  if (selectedDetailId) return;
  const meetingType = meetingTypeClass(block.type);
  const meetingLabel = ({ le: 'Lecture', di: 'Discussion', lab: 'Lab' })[meetingType] || 'Class';
  const badgeClass = ({ le: 'lecture', di: 'discussion', lab: 'lab' })[meetingType] || 'other';
  const backdrop = document.createElement('div');
  backdrop.className = 'modal-backdrop';
  backdrop.innerHTML = `<div class="modal schedule-quicklook-modal" role="dialog" aria-modal="true" aria-label="${escapeHtml(cls.courseAbbr)} class details">
    <div class="modal-head"><div class="modal-title">${escapeHtml(cls.courseAbbr)} · ${escapeHtml(cls.courseTitle)}</div><button class="modal-close" aria-label="Close">&times;</button></div>
    <div class="modal-body">
      <div class="detail-grid">
        <span>Type</span><strong><span class="detail-type-badge ${badgeClass}">${meetingLabel}</span></strong>
        <span>Professor</span><strong>${escapeHtml(cls.instructor || 'Staff')}</strong>
        <span>Room</span><strong>${escapeHtml(block.location || 'Room unavailable')}</strong>
        <span>Time</span><strong>${escapeHtml(minutesToLabel(timeToMinutes(block.start)))} – ${escapeHtml(minutesToLabel(timeToMinutes(block.end)))}</strong>
        <span>Units</span><strong>${escapeHtml(cls.credits ?? 'Unavailable')}</strong>
      </div>
    </div>
    <div class="modal-foot"><button class="btn btn-primary js-quicklook-close">Close</button></div>
  </div>`;
  document.body.appendChild(backdrop);
  const keyHandler = (event) => { if (event.key === 'Escape') close(); };
  const close = () => {
    document.removeEventListener('keydown', keyHandler);
    backdrop.remove();
  };
  backdrop.querySelector('.modal-close').addEventListener('click', close);
  backdrop.querySelector('.js-quicklook-close').addEventListener('click', close);
  backdrop.addEventListener('click', (event) => { if (event.target === backdrop) close(); });
  document.addEventListener('keydown', keyHandler);
}

function compactTimeRange(start, end) {
  const startMinutes = timeToMinutes(start);
  const endMinutes = timeToMinutes(end);
  const clock = (minutes) => {
    const hour = Math.floor(minutes / 60) % 12 || 12;
    return `${hour}:${String(minutes % 60).padStart(2, '0')}`;
  };
  const startSuffix = startMinutes >= 720 ? 'PM' : 'AM';
  const endSuffix = endMinutes >= 720 ? 'PM' : 'AM';
  return startSuffix === endSuffix
    ? `${clock(startMinutes)}–${clock(endMinutes)} ${endSuffix}`
    : `${clock(startMinutes)} ${startSuffix}–${clock(endMinutes)} ${endSuffix}`;
}

function groupScheduleBlocks(blocks, includeFinals = true, separateTypes = false) {
  const groups = new Map();
  for (const block of blocks || []) {
    if (block.isFinal && !includeFinals) continue;
    const key = block.isFinal
      ? `final|${block.finalDate}|${block.start}|${block.end}|${block.location}`
      : `${separateTypes ? block.type : ''}|${block.start}|${block.end}|${String(block.location || '').trim()}`;
    if (!groups.has(key)) groups.set(key, { block, days: new Set() });
    if (!block.isFinal) groups.get(key).days.add(block.day);
  }
  const dayOrder = new Map(DAYS.map((day, index) => [day, index]));
  return [...groups.values()].map(({ block, days }) => ({
    block,
    dayLabel: [...days].sort((a, b) => (dayOrder.get(a) ?? 99) - (dayOrder.get(b) ?? 99)).join(''),
  }));
}

function scheduleSummary(blocks, includeFinals = showFinals) {
  return groupScheduleBlocks(blocks, includeFinals).map(({ block, dayLabel }) => {
    if (block.isFinal) return `${finalDateLabel(block)} ${compactTimeRange(block.start, block.end)} ${roomLabel(block.location)}`;
    return `${dayLabel} ${compactTimeRange(block.start, block.end)} ${roomLabel(block.location)}`;
  });
}

function detailScheduleHtml(blocks) {
  const rows = groupScheduleBlocks(blocks, true, true);
  return rows.map(({ block, dayLabel }) => {
    const code = block.isFinal ? 'FI' : block.type === 'LE' ? 'L' : block.type;
    const typeClass = meetingTypeClass(block.type);
    const className = block.isFinal ? 'final' : typeClass === 'le' ? 'lecture' : typeClass === 'di' ? 'discussion' : typeClass === 'lab' ? 'lab' : 'other';
    const label = block.isFinal
      ? `Final exam · ${finalDateLabel(block)} · ${compactTimeRange(block.start, block.end)} · ${block.location}`
      : `${dayLabel} ${compactTimeRange(block.start, block.end)} · ${block.location}`;
    return `<div class="detail-section-row"><span class="detail-type-badge ${className}">[${escapeHtml(code)}]</span><span>${escapeHtml(label)}</span></div>`;
  }).join('');
}

function renderFinalCalendar() {
  const axis = document.getElementById('final-time-axis');
  const columns = document.getElementById('final-day-columns');
  if (!axis || !columns) return;
  axis.replaceChildren();
  columns.replaceChildren();
  const byDate = new Map();
  const seen = new Set();
  for (const cls of planned) {
    for (const block of cls.scheduleBlocks || []) {
      if (!block.isFinal || !block.finalDate) continue;
      const key = `${cls.id}|${block.finalDate}|${block.start}|${block.end}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const date = dateFromFinal(block.finalDate);
      if (!date) continue;
      if (!byDate.has(block.finalDate)) byDate.set(block.finalDate, { date, blocks: [] });
      byDate.get(block.finalDate).blocks.push({ cls, block });
    }
  }

  const sortedDates = [...byDate.entries()].sort((a, b) => a[1].date - b[1].date);
  const allBlocks = sortedDates.flatMap(([, group]) => group.blocks);
  const empty = document.getElementById('final-calendar-empty');
  if (empty) empty.classList.toggle('hidden', allBlocks.length > 0);
  if (!allBlocks.length) return;

  const firstHour = 8;
  const lastHour = 20;
  const hourHeight = isPlanner ? 50 : 26;
  const headerHeight = 24;
  const bodyHeight = (lastHour - firstHour) * hourHeight;
  const clockLabel = (hour) => `${hour % 12 || 12}${hour >= 12 ? 'p' : 'a'}`;
  axis.style.setProperty('--final-header-height', `${headerHeight}px`);
  axis.style.height = `${headerHeight + bodyHeight}px`;
  const axisHead = document.createElement('div');
  axisHead.className = 'final-axis-head';
  axis.appendChild(axisHead);
  for (let hour = firstHour; hour <= lastHour; hour += 2) {
    const label = document.createElement('span');
    label.className = 'final-time-label';
    label.style.top = `${headerHeight + (hour - firstHour) * hourHeight}px`;
    if (hour === lastHour) label.style.transform = 'translateY(-100%)';
    label.textContent = clockLabel(hour);
    axis.appendChild(label);
  }

  // Build a contiguous list of days across the full finals window so students
  // can see day-gaps between exams rather than only days that have finals.
  const finalDays = sortedDates.map(([, group]) => group.date);
  const windowStart = new Date(finalDays[0]);
  windowStart.setHours(0, 0, 0, 0);
  const windowEnd = new Date(finalDays[finalDays.length - 1]);
  windowEnd.setHours(0, 0, 0, 0);
  // Map midnight-timestamp -> finalDate string key so we can look up groups
  // for each day in the window regardless of the source string's zero-padding.
  const finalDateKeyByTimestamp = new Map();
  for (const [dateKey, group] of sortedDates) {
    const ts = new Date(group.date.getFullYear(), group.date.getMonth(), group.date.getDate()).getTime();
    finalDateKeyByTimestamp.set(ts, dateKey);
  }
  const allDays = [];
  for (let d = new Date(windowStart); d <= windowEnd; d.setDate(d.getDate() + 1)) {
    allDays.push(new Date(d));
  }

  columns.style.gridTemplateColumns = `repeat(${allDays.length}, minmax(128px, 1fr))`;
  columns.style.setProperty('--final-hour-height', `${hourHeight}px`);
  for (const dayDate of allDays) {
    const ts = new Date(dayDate.getFullYear(), dayDate.getMonth(), dayDate.getDate()).getTime();
    const dateKey = finalDateKeyByTimestamp.get(ts);
    const group = dateKey ? byDate.get(dateKey) : null;
    const day = document.createElement('section');
    const count = group ? group.blocks.length : 0;
    day.className = `final-day-column${count === 0 ? ' no-finals' : count === 2 ? ' two-finals' : count >= 3 ? ' many-finals' : ''}`;
    const head = document.createElement('div');
    head.className = 'final-day-head';
    head.textContent = new Intl.DateTimeFormat('en-US', { weekday: 'short', month: 'numeric', day: 'numeric' }).format(dayDate);
    if (group) head.title = finalDateLabel({ finalDate: dateKey });
    const events = document.createElement('div');
    events.className = 'final-day-events';
    events.style.height = `${bodyHeight}px`;
    if (group) {
      const finalEntries = assignOverlapLanes(group.blocks.map((item) => ({ item, block: item.block })));
      for (const placement of finalEntries) {
        const { item, lane, laneCount } = placement;
        const top = ((timeToMinutes(item.block.start) - firstHour * 60) / 60) * hourHeight;
        const height = Math.max(((timeToMinutes(item.block.end) - timeToMinutes(item.block.start)) / 60) * hourHeight, 14);
        const event = document.createElement('div');
        event.className = `final-time-block${laneCount > 1 ? ' final-time-conflict' : ''}`;
        event.style.top = `${top}px`;
        event.style.height = `${height}px`;
        event.style.left = `${(lane / laneCount) * 100}%`;
        event.style.width = `${100 / laneCount}%`;
        const course = document.createElement('span');
        course.className = 'final-block-course';
        course.textContent = item.cls.courseAbbr;
        const time = document.createElement('span');
        time.className = 'final-block-time';
        time.textContent = compactTimeRange(item.block.start, item.block.end);
        const details = document.createElement('span');
        details.className = 'final-block-details';
        details.textContent = `${item.block.location || 'Room unavailable'} | ${item.cls.instructor || 'Staff'}`;
        event.append(course, time, details);
        event.title = `${item.cls.courseAbbr} · ${compactTimeRange(item.block.start, item.block.end)} · ${roomLabel(item.block.location)}`;
        event.title = [item.cls.courseAbbr, item.cls.courseTitle, compactTimeRange(item.block.start, item.block.end), item.block.location, item.cls.instructor || 'Staff'].filter(Boolean).join(' | ');
        events.appendChild(event);
      }
    }
    day.append(head, events);
    columns.appendChild(day);
  }
}

function renderFinalsList() {
  const section = document.getElementById('finals-section');
  const list = document.getElementById('finals-list');
  if (!section || !list) return;
  const finals = planned.flatMap((cls) => (cls.scheduleBlocks || [])
    .filter((block) => block.isFinal)
    .map((block) => ({ cls, block }))
  ).sort((a, b) => String(a.block.finalDate).localeCompare(String(b.block.finalDate)));
  section.classList.toggle('hidden', !showFinals || finals.length === 0);
  list.innerHTML = finals.map(({ cls, block }) => `
    <div class="final-row">
      <strong>${escapeHtml(cls.courseAbbr)}</strong>
      <span>${escapeHtml(finalDateLabel(block))}</span>
      <span>${escapeHtml(finalTimeLabel(block))}</span>
      <span>${escapeHtml(block.location)}</span>
    </div>`).join('');
}

function renderPlannedList() {
  const list = document.getElementById('planned-list');
  const empty = document.getElementById('planned-empty');
  const count = document.getElementById('planned-count');
  list.innerHTML = '';
  count.textContent = planned.length;
  if (planned.length === 0) {
    empty.classList.remove('hidden');
    renderFinalsList();
    return;
  }
  empty.classList.add('hidden');
  const { conflictBlockKeys, finalConflictClassIds } = detectConflicts(planned);
  for (const cls of [...planned].sort((a, b) => Number(Boolean(b.registered)) - Number(Boolean(a.registered)))) {
    const hasScheduleConflict = cls.scheduleBlocks.some(
      (b) => !b.isFinal && conflictBlockKeys.has(`${cls.id}|${b.day}|${b.start}|${b.end}`)
    );
    const hasFinalConflict = finalConflictClassIds.has(cls.id);
    const card = document.createElement('div');
    let cardClass = 'planned-card';
    if (hasFinalConflict) cardClass += ' final-conflict-card';
    else if (hasScheduleConflict) cardClass += ' conflict-card';
    card.className = cardClass;

    const scheduleTags = scheduleSummary(cls.scheduleBlocks || [])
      .map((label) => `<span class="schedule-tag">${escapeHtml(label)}</span>`)
      .join('');

    const hasSeatData = cls.seatsAvailable != null && cls.seatsTotal != null;
    const seatsCls = hasSeatData ? seatsClass(cls.seatsAvailable, cls.seatsTotal) : 'muted';
    const isRefreshing = singleClassRefreshes.has(cls.id);
    const refreshLabel = `${isRefreshing ? 'Refreshing' : 'Refresh'} ${cls.courseAbbr} class info`;

    let conflictNote = '';
    if (hasFinalConflict) {
      conflictNote = '<div class="conflict-note conflict-final">⚠ Final exam conflict detected</div>';
    } else if (hasScheduleConflict) {
      conflictNote = '<div class="conflict-note conflict-schedule">⚠ Schedule overlap on some sections</div>';
    }

    card.innerHTML = `
      <div class="planned-card-head">
        <div class="planned-card-title">
          <span class="planned-card-abbr">${escapeHtml(cls.courseAbbr)}</span>
          ${cls.registered ? '<span class="planned-registered-star" title="Registered in your UCSD schedule" aria-label="Registered in your UCSD schedule">★</span>' : ''}
          <span class="planned-card-name">${escapeHtml(cls.courseTitle)}</span>
        </div>
        <div class="planned-card-actions">
          <button type="button" class="btn class-refresh-btn js-refresh-class${isRefreshing ? ' is-refreshing' : ''}" data-id="${escapeHtml(cls.id)}" title="${escapeHtml(refreshLabel)}" aria-label="${escapeHtml(refreshLabel)}" ${isRefreshing ? 'disabled' : ''}>
            <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20 7v5h-5M4 17v-5h5M5.6 9a7 7 0 0 1 11.6-2.6L20 12M4 12l2.8 5.6A7 7 0 0 0 18.4 15"/></svg>
          </button>
          <button class="btn btn-small js-details" data-id="${escapeHtml(cls.id)}">Class details</button>
          <button class="btn btn-small js-requirements" data-id="${escapeHtml(cls.id)}">Requirements</button>
          ${cls.eventPkgObjid ? `<button class="btn btn-small btn-primary js-open" data-id="${escapeHtml(cls.id)}">Open in TSS</button>` : ''}
          <button class="btn-danger-text js-remove" data-id="${escapeHtml(cls.id)}" title="Remove">&times;</button>
        </div>
      </div>
      <div class="planned-card-body">
        <div class="planned-schedule">${scheduleTags}</div>
        <div class="planned-info">
          <span class="planned-info-label">Open seats:</span>
          <span class="${seatsCls}">${hasSeatData ? `${escapeHtml(cls.seatsAvailable)}/${escapeHtml(cls.seatsTotal)}` : '—'}</span>
        </div>
        <div class="planned-info">
          <span class="planned-info-label">Total waitlist:</span>
          <span>${escapeHtml(cls.waitlistTotal ?? '—')}</span>
        </div>
        <div class="planned-info">
          <span class="planned-info-label">Instructor:</span>
          <span>${escapeHtml(cls.instructor || 'Unavailable')}</span>
        </div>
        <div class="planned-info">
          <span class="planned-info-label">Credits:</span>
          <span>${escapeHtml(cls.credits || '—')}</span>
        </div>
        ${cls.unavailable ? '<div class="conflict-note conflict-schedule">Selected section is no longer listed by TSS</div>' : ''}
        ${conflictNote}
      </div>
    `;
    list.appendChild(card);
  }
  renderFinalsList();
  list.querySelectorAll('.js-remove').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      const id = e.currentTarget.dataset.id;
      chrome.storage.local.get('plannedClasses').then(({ plannedClasses }) => {
        planned = (Array.isArray(plannedClasses) ? plannedClasses : []).filter((c) => c.id !== id);
        return chrome.storage.local.set({ plannedClasses: planned });
      }).then(renderAll);
    });
  });
  list.querySelectorAll('.js-open').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      const id = e.currentTarget.dataset.id;
      const cls = planned.find((c) => c.id === id);
      if (cls) chrome.tabs.create({ url: tssLink(cls) });
    });
  });
  list.querySelectorAll('.js-requirements').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      const id = e.currentTarget.dataset.id;
      const cls = planned.find((c) => c.id === id);
      if (cls) openRequirementsModal(cls);
    });
  });
  list.querySelectorAll('.js-refresh-class').forEach((btn) => {
    btn.addEventListener('click', (e) => refreshClassInfo(e.currentTarget.dataset.id));
  });
  list.querySelectorAll('.js-details').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      const cls = planned.find((c) => c.id === e.currentTarget.dataset.id);
      if (cls) openClassDetails(cls);
    });
  });
}

function renderAll() {
  renderCalendar();
  renderFinalCalendar();
  renderPlannedList();
}

function termForClass(cls) {
  return { academicYear: cls.academicYear, academicPeriod: cls.academicPeriod };
}

function bookingDate(value) {
  const match = String(value || '').match(/\/Date\((\d+)/);
  if (!match) return value || '';
  return new Intl.DateTimeFormat('en-US', {
    weekday: 'short', month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC',
  }).format(new Date(Number(match[1])));
}

function bookingDateKey(value) {
  const raw = String(value || '');
  const encoded = raw.match(/\/Date\((\d+)/);
  const date = encoded ? new Date(Number(encoded[1])) : new Date(raw);
  if (Number.isNaN(date.getTime())) return '';
  const month = (encoded ? date.getUTCMonth() : date.getMonth()) + 1;
  const day = encoded ? date.getUTCDate() : date.getDate();
  const year = encoded ? date.getUTCFullYear() : date.getFullYear();
  return `${month}/${day}/${year}`;
}

function durationTime(value) {
  const match = String(value || '').match(/^PT(?:(\d+)H)?(?:(\d+)M)?/);
  if (!match) return value || '';
  const hours = Number(match[1] || 0);
  const minutes = Number(match[2] || 0);
  const suffix = hours >= 12 ? 'PM' : 'AM';
  const hour12 = hours % 12 || 12;
  return `${hour12}:${String(minutes).padStart(2, '0')} ${suffix}`;
}

function normalizeEventId(value) {
  return String(value || '').replace(/\D/g, '').replace(/^0+(?=\d)/, '');
}

function meetingDayCode(value) {
  const day = String(value || '').trim().toLowerCase().slice(0, 3);
  return ({ mon: 'M', tue: 'Tu', wed: 'W', thu: 'Th', fri: 'F', sat: 'Sa', sun: 'Su' })[day] || '';
}

function parseODataV2Date(value) {
  const match = String(value || '').match(/\/Date\((-?\d+)\)\//);
  return match ? Number(match[1]) : null;
}

function parseIsoDuration(value) {
  const match = String(value || '').match(/^PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/);
  if (!match) return null;
  return Number(match[1] || 0) * 60 + Number(match[2] || 0);
}

function minutesToClock(minutes) {
  return `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
}

function parseEventName(eventName) {
  const match = String(eventName || '').match(/^([A-Z]+)-(\d+[A-Z]*)-([A-Z]+)\s*\((\d+)-(\d+)\)$/);
  if (!match) return null;
  return { courseAbbr: `${match[1]}-${match[2]}`, meetingType: match[3], section: `${match[4]}-${match[5]}` };
}

function normalizeScheduleEvent(row) {
  const dateMs = parseODataV2Date(row.EventDate);
  const startMinutes = parseIsoDuration(row.StartTime);
  const endMinutes = parseIsoDuration(row.EndTime);
  const name = parseEventName(row.EventName);
  const isHoliday = row.EventType === '03' || String(row.ModuleId || '') === '00000000';
  return {
    key: `${row.EventId}|${row.EventDate}|${row.StartTime}|${row.EndTime}`,
    eventId: normalizeEventId(row.EventId),
    moduleId: String(row.ModuleId || ''),
    courseName: row.CourseName || '',
    eventName: row.EventName || '',
    courseAbbr: name?.courseAbbr || '',
    meetingType: name?.meetingType || '',
    section: name?.section || '',
    teachingMethod: row.TeachingMethod || '',
    isHoliday,
    isFinal: !isHoliday && startMinutes != null && endMinutes != null && endMinutes - startMinutes >= 150,
    dateMs,
    dateKey: dateMs == null ? '' : bookingDateKey(row.EventDate),
    dateLabel: dateMs == null ? '' : bookingDate(row.EventDate),
    day: dateMs == null ? '' : meetingDayCode(new Date(dateMs).toUTCString().slice(0, 3)),
    startMinutes,
    endMinutes,
    start: startMinutes == null ? '' : minutesToClock(startMinutes),
    end: endMinutes == null ? '' : minutesToClock(endMinutes),
    room: row.Room || '',
    location: row.Location || '',
  };
}

function parseEventList(rows) {
  return Array.isArray(rows) ? rows.map(normalizeScheduleEvent) : [];
}

function enrichBookingRooms(event, sectionRows = []) {
  const eventId = normalizeEventId(event.eventId);
  if (!eventId) return event;
  const sectionBlocks = sectionRows
    .filter((row) => normalizeEventId(row.EventID) === eventId)
    .flatMap((row) => parseSched(row.Sched, row.TeachingMethod));
  const rooms = [...new Set(sectionBlocks.map((block) => block.location).filter(Boolean))];
  const meetings = (event.events || []).map((meeting) => {
    const start = to24h(meeting.start);
    const end = to24h(meeting.end);
    const dayCode = meetingDayCode(meeting.day) || meetingDayCode(meeting.date);
    let matching = sectionBlocks.filter((block) => !block.isFinal && block.start === start && block.end === end && dayCode && block.day === dayCode);
    if (!matching.length) {
      const dateKey = meeting.dateKey || bookingDateKey(meeting.date);
      matching = sectionBlocks.filter((block) => block.isFinal && block.finalDate === dateKey && block.start === start && block.end === end);
    }
    if (!matching.length) matching = sectionBlocks.filter((block) => !block.isFinal && block.start === start && block.end === end);
    const matchingRooms = [...new Set(matching.map((block) => block.location).filter(Boolean))];
    return {
      ...meeting,
      location: matchingRooms.length ? matchingRooms.join(', ') : meeting.location,
    };
  });
  return {
    ...event,
    room: rooms.length ? rooms.join('; ') : event.room,
    events: meetings,
  };
}

function normalizeBooking(events, sectionRows = []) {
  return (events || []).map((event) => enrichBookingRooms({
    eventId: event.EventId,
    method: event.MethodText || event.Method || 'Class',
    booked: Boolean(event.Booked),
    waitlistPosition: Number(event.WaitlistPosition) || 0,
    waitlistBooking: Boolean(event.WaitlistBooking),
    registrationState: event.Booked ? 'Booked' : event.WaitlistBooking ? 'On waitlist' : event.SelectBtnEnable ? 'Registration action available' : event.Disabled ? 'Unavailable' : 'Not currently selectable',
    registrationBegin: bookingDate(event.RegistrationBeginDate),
    registrationEnd: bookingDate(event.RegistrationEndDate),
    room: event.RoomShort || event.RoomStext || '',
    events: (event.EventSchedule?.results || []).map((schedule) => ({
      date: bookingDate(schedule.EventDate),
      dateKey: bookingDateKey(schedule.EventDate),
      day: schedule.DayName || '',
      start: durationTime(schedule.StartTime),
      end: durationTime(schedule.EndTime),
      kind: schedule.MeetingTypeText || '',
      location: [event.RoomShort || event.RoomStext, schedule.ScheduleAdditionalInfo].filter(Boolean).join(' · '),
    })),
  }, sectionRows));
}

function bookingEventsContainRegistration(events) {
  return (events || []).some((event) => Boolean(event.Booked || event.WaitlistBooking));
}

function updateStoredClass(id, updater) {
  return chrome.storage.local.get('plannedClasses').then(({ plannedClasses }) => {
    const next = Array.isArray(plannedClasses) ? plannedClasses : [];
    const index = next.findIndex((item) => item.id === id);
    if (index >= 0) next[index] = updater(next[index]);
    return chrome.storage.local.set({ plannedClasses: next }).then(() => {
      planned = next;
      renderAll();
      return next[index];
    });
  });
}

function scheduleTermCandidates(baseTerm = currentTerm || DEFAULT_TERM) {
  const base = baseTerm || DEFAULT_TERM;
  const academicYear = String(base.academicYear || DEFAULT_TERM.academicYear);
  const currentPeriod = String(base.academicPeriod || DEFAULT_TERM.academicPeriod);
  return [...new Set([currentPeriod, '1', '2', '3', '4'])]
    .map((academicPeriod) => ({ academicYear, academicPeriod }));
}

function scheduleBlocksForEvents(events) {
  const blocksByKey = new Map();
  for (const event of events) {
    if (!event.start || !event.end || !event.day) continue;
    const type = event.teachingMethod || event.meetingType || 'LE';
    const block = {
      day: event.isFinal ? 'Final' : event.day,
      ...(event.isFinal ? { finalDate: event.dateKey } : {}),
      start: event.start,
      end: event.end,
      location: event.room || 'Location unavailable',
      type,
      ...(event.isFinal ? { isFinal: true } : {}),
    };
    const key = `${block.day}|${block.finalDate || ''}|${block.start}|${block.end}|${block.location}|${block.type}`;
    blocksByKey.set(key, block);
  }
  return [...blocksByKey.values()];
}

function packageEventIds(pkg) {
  return new Set((pkg?.raw || []).map((row) => normalizeEventId(row.EventID)).filter(Boolean));
}

function findPackageForEventIds(packages, eventIds, sectionIds = []) {
  const expected = eventIds instanceof Set ? eventIds : new Set(eventIds || []);
  const expectedSections = sectionIds instanceof Set ? sectionIds : new Set(sectionIds || []);
  if (!expected.size) return null;
  const ranked = packages.map((pkg) => {
    const ids = packageEventIds(pkg);
    const matched = [...ids].filter((id) => expected.has(id)).length;
    const complete = ids.size > 0 && matched === ids.size;
    const exact = complete && expected.size === ids.size;
    const sectionMatched = expectedSections.has(String(pkg.displayID || '').trim())
      || (pkg.raw || []).some((row) => expectedSections.has(String(row.EventPkgDisplayID || '').trim()));
    return { pkg, matched, complete, exact, sectionMatched };
  }).filter((item) => item.matched > 0)
    .sort((a, b) => Number(b.sectionMatched) - Number(a.sectionMatched)
      || Number(b.exact) - Number(a.exact)
      || Number(b.complete) - Number(a.complete)
      || b.matched - a.matched
      || packageEventIds(a.pkg).size - packageEventIds(b.pkg).size);
  if (!ranked.length) return null;
  if (ranked.length > 1 && ranked[0].sectionMatched === ranked[1].sectionMatched
      && ranked[0].exact === ranked[1].exact
      && ranked[0].complete === ranked[1].complete && ranked[0].matched === ranked[1].matched
      && packageEventIds(ranked[0].pkg).size === packageEventIds(ranked[1].pkg).size) return null;
  return ranked[0].pkg;
}

function scheduleClassGroups(events) {
  const groups = new Map();
  const term = currentTerm || DEFAULT_TERM;
  for (const event of events) {
    if (event.isHoliday || !event.moduleId || !event.eventId) continue;
    const key = event.moduleId;
    if (!groups.has(key)) groups.set(key, { key, moduleID: event.moduleId, term: { ...term }, events: [] });
    groups.get(key).events.push(event);
  }
  return [...groups.values()];
}

function registeredClassRecord(group, pkg, existing, now, sectionError = null) {
  const events = group.events;
  const sample = events.find((event) => event.courseAbbr) || events[0];
  const eventIds = [...new Set(events.map((event) => event.eventId).filter(Boolean))];
  const scheduleBlocks = scheduleBlocksForEvents(events);
  const courseAbbr = sample.courseAbbr || existing?.courseAbbr || sample.eventName || group.moduleID;
  const keepsPackage = !pkg || (existing?.selectedPackageOtjid === pkg.otjid && existing?.eventPkgObjid === pkg.objid);
  const term = pkg ? group.term : {
    academicYear: existing?.academicYear || group.term.academicYear,
    academicPeriod: existing?.academicPeriod || group.term.academicPeriod,
  };
  return {
    ...(existing || {}),
    id: existing?.id || `sync-${group.moduleID}-${term.academicYear}-${term.academicPeriod}-${pkg?.otjid || 'schedule'}`,
    moduleID: group.moduleID,
    courseAbbr,
    courseTitle: sample.courseName || existing?.courseTitle || courseAbbr,
    credits: existing?.credits || '',
    academicYear: term.academicYear,
    academicPeriod: term.academicPeriod,
    departmentAbbr: existing?.departmentAbbr || courseAbbr.split('-')[0] || '',
    selectedPackageOtjid: pkg?.otjid || existing?.selectedPackageOtjid || '',
    eventPkgObjid: pkg?.objid || existing?.eventPkgObjid || '',
    seatsAvailable: pkg?.seatsAvailable ?? existing?.seatsAvailable ?? null,
    seatsTotal: pkg?.seatsTotal ?? existing?.seatsTotal ?? null,
    waitlistTotal: pkg?.waitlistTotal ?? existing?.waitlistTotal ?? null,
    instructor: pkg?.instructor || existing?.instructor || 'Unavailable',
    status: pkg?.status || existing?.status || 'Registered',
    location: pkg?.location || existing?.location || '',
    scheduleBlocks: scheduleBlocks.length ? scheduleBlocks : pkg?.scheduleBlocks || existing?.scheduleBlocks || [],
    _lastPkg: pkg || existing?._lastPkg || null,
    syncedEventIds: eventIds,
    syncedSections: [...new Set(events.map((event) => event.section).filter(Boolean))],
    syncedFromSchedule: true,
    registered: true,
    registeredFetchedAt: now,
    sectionFetchedAt: pkg ? now : existing?.sectionFetchedAt || null,
    sectionError: pkg ? null : sectionError || existing?.sectionError || null,
    bookingDetails: keepsPackage ? existing?.bookingDetails || null : null,
    bookingFetchedAt: keepsPackage ? existing?.bookingFetchedAt || null : null,
    bookingError: keepsPackage ? existing?.bookingError || null : null,
    availablePackages: pkg ? [] : existing?.availablePackages || [],
    unavailable: false,
    addedAt: existing?.addedAt || now,
    scheduleOnly: !pkg && !existing?.eventPkgObjid,
  };
}

async function syncSchedule() {
  if (scheduleSyncActive) return;
  if (activeRefreshId || fullRefreshStarting || singleClassRefreshes.size) {
    showRefreshStatus('Wait for the current class refresh to finish before syncing your schedule.');
    return;
  }
  scheduleSyncActive = true;
  const button = document.getElementById('sync-schedule');
  if (button) {
    button.disabled = true;
    button.textContent = 'Syncing…';
  }
  const refreshId = `schedule-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  try {
    const { lastRefreshRun, scheduleSyncRun } = await chrome.storage.local.get(['lastRefreshRun', 'scheduleSyncRun']);
    const currentRefresh = lastRefreshRun?.startedAt && !lastRefreshRun.finishedAt
      && Date.now() - lastRefreshRun.startedAt < 30 * 60 * 1000;
    const currentSync = scheduleSyncRun?.startedAt && !scheduleSyncRun.finishedAt
      && Date.now() - scheduleSyncRun.startedAt < 30 * 60 * 1000;
    if (currentRefresh || currentSync) {
      showRefreshStatus(currentRefresh
        ? 'A class refresh is already running in another planner tab.'
        : 'Schedule sync is already running in another planner tab.');
      return;
    }
    await chrome.storage.local.set({ scheduleSyncRun: { refreshId, startedAt: Date.now(), finishedAt: null } });
    const year = new Date().getFullYear();
    const from = `${year - 1}-01-01`;
    const to = `${year + 1}-12-31`;
    showRefreshStatus('Reading your registered schedule…');
    const timetableResult = await sendRuntimeMessage({ type: 'getTimetable', from, to, refreshId });
    if (timetableResult?.error) {
      if (['no-auth', 'auth-expired'].includes(timetableResult.error)) showAuthBanner('expired');
      showRefreshStatus(`Could not sync schedule (${timetableResult.error}${timetableResult.status ? ` ${timetableResult.status}` : ''}).`, true);
      return;
    }

    const events = parseEventList(timetableResult.events);
    const groups = scheduleClassGroups(events);
    const cacheKey = `${from}|${to}`;
    const storedTimetableRanges = await chrome.storage.local.get('timetableRanges');
    const timetableRanges = storedTimetableRanges.timetableRanges && typeof storedTimetableRanges.timetableRanges === 'object'
      ? storedTimetableRanges.timetableRanges
      : {};
    await chrome.storage.local.set({ timetableRanges: {
      ...timetableRanges,
      [cacheKey]: { from, to, events, fetchedAt: Date.now() },
    } });
    const now = Date.now();
    let authFailed = false;
    let groupIndex = 0;
    const syncResults = [];
    for (const group of groups) {
      groupIndex++;
      const sample = group.events.find((event) => event.courseAbbr) || group.events[0];
      const label = sample.courseAbbr || sample.courseName || group.moduleID;
      showRefreshStatus(`Syncing registered classes ${groupIndex} of ${groups.length}: ${label}…`);
      const eventIds = new Set(group.events.map((event) => event.eventId).filter(Boolean));
      const sectionIds = new Set(group.events.map((event) => event.section).filter(Boolean));
      let pkg = null;
      let sectionResult = null;
      for (const term of scheduleTermCandidates(group.term)) {
        try {
          sectionResult = await sendRuntimeMessage({ type: 'getSections', moduleID: group.moduleID, term, refreshId });
        } catch (error) {
          sectionResult = { error: error.message || 'network' };
        }
        if (['no-auth', 'auth-expired'].includes(sectionResult?.error)) {
          authFailed = true;
          break;
        }
        if (sectionResult?.error) continue;
        const packages = groupSections(sectionResult.sections || []);
        pkg = findPackageForEventIds(packages, eventIds, sectionIds);
        if (pkg) {
          group.term = term;
          break;
        }
      }
      const sectionError = sectionResult?.error
        ? [sectionResult.error, sectionResult.message].filter(Boolean).join(': ')
        : pkg ? null : 'No section package matched the registered timetable events';
      syncResults.push({ group, pkg, sectionError });
    }
    const { plannedClasses } = await chrome.storage.local.get('plannedClasses');
    const next = (Array.isArray(plannedClasses) ? plannedClasses : []).map((cls) => ({ ...cls, registered: false }));
    for (const result of syncResults) {
      const { group, pkg, sectionError } = result;
      const packageIds = packageEventIds(pkg);
      const moduleMatches = next.filter((cls) => String(cls.moduleID) === group.moduleID);
      const matching = pkg ? moduleMatches.filter((cls) => String(cls.academicYear) === String(group.term.academicYear)
        && String(cls.academicPeriod) === String(group.term.academicPeriod)) : moduleMatches;
      let existing = matching.find((cls) => pkg && cls.selectedPackageOtjid === pkg.otjid);
      const expectedIds = packageIds.size ? packageIds : new Set(group.events.map((event) => event.eventId).filter(Boolean));
      if (!existing && expectedIds.size) {
        existing = matching.find((cls) => [...packageEventIds(cls._lastPkg)].some((id) => expectedIds.has(id))
          || (cls.syncedEventIds || []).some((id) => expectedIds.has(normalizeEventId(id))));
      }
      if (!existing && matching.length === 1) existing = matching[0];
      const record = registeredClassRecord(group, pkg, existing, now, sectionError);
      if (existing) {
        const index = next.findIndex((cls) => cls.id === existing.id);
        if (index >= 0) next[index] = record;
      } else {
        next.push(record);
      }
    }
    await chrome.storage.local.set({ plannedClasses: next });
    planned = next;
    renderAll();
    await chrome.runtime.sendMessage({ type: 'finishRefresh', refreshId }).catch(() => undefined);
    const registeredCount = groups.length;
    showRefreshStatus(registeredCount
      ? `Schedule synced: ${registeredCount} registered ${registeredCount === 1 ? 'class' : 'classes'} marked with a star.`
      : 'Schedule synced. No registered classes were returned.', false, 100);
    if (authFailed) showAuthBanner('expired');
  } catch (error) {
    showRefreshStatus(`Could not sync schedule: ${error.message || 'unknown error'}`, true);
  } finally {
    await chrome.runtime.sendMessage({ type: 'finishRefresh', refreshId }).catch(() => undefined);
    const { scheduleSyncRun } = await chrome.storage.local.get('scheduleSyncRun').catch(() => ({}));
    if (scheduleSyncRun?.refreshId === refreshId) {
      await chrome.storage.local.set({ scheduleSyncRun: { ...scheduleSyncRun, finishedAt: Date.now() } }).catch(() => undefined);
    }
    scheduleSyncActive = false;
    if (button) {
      button.disabled = false;
      button.textContent = 'Sync schedule';
    }
  }
}

function bookingDetailHtml(cls) {
  const info = cls.bookingDetails;
  if (!info?.events?.length) {
    return cls.bookingFetchedAt
      ? '<p class="muted">No booking options were returned for this section.</p>'
      : '<p class="muted">No booking details are cached yet.</p>';
  }
  const sectionRows = cls._lastPkg?.raw || [];
  return info.events.map((cachedEvent) => {
    const event = enrichBookingRooms(cachedEvent, sectionRows);
    return `
    <section class="detail-event">
      <h4>${escapeHtml(event.method || 'Booking option')}</h4>
      <div class="detail-grid">
        <span>Booked</span><strong>${event.booked ? 'Yes' : 'No'}</strong>
        <span>Your waitlist position</span><strong>${escapeHtml(event.waitlistPosition > 0 ? event.waitlistPosition : event.waitlistBooking ? 'Position unavailable' : 'Not waitlisted')}</strong>
        <span>Waitlist booking</span><strong>${event.waitlistBooking ? 'Yes' : 'No'}</strong>
        <span>Registration state</span><strong>${escapeHtml(event.registrationState || 'Unavailable')}</strong>
        <span>Room</span><strong>${escapeHtml(event.room || 'Unavailable')}</strong>
        <span>Registration window</span><strong>${escapeHtml([event.registrationBegin, event.registrationEnd].filter(Boolean).join(' – ') || 'Unavailable')}</strong>
      </div>
      ${event.events?.length ? `<details class="detail-meetings"><summary>Meetings</summary><ul>${event.events.map((meeting) => `
        <li><strong>${escapeHtml(meeting.day)} ${escapeHtml(meeting.date)}</strong><span>${escapeHtml(meeting.start)}–${escapeHtml(meeting.end)}</span><span>${escapeHtml(meeting.kind || 'Meeting')}</span><span>${escapeHtml(meeting.location || 'Location unavailable')}</span></li>
      `).join('')}</ul></details>` : '<p class="muted">No dated meeting information is cached.</p>'}
    </section>`;
  }).join('');
}

function renderClassDetailsBody(body, classId) {
  const current = planned.find((item) => item.id === classId);
  if (!current) return;
  const schedule = detailScheduleHtml(current.scheduleBlocks || []);
  const selectedSectionLabel = current.selectedPackageOtjid ? `Selected section ${escapeHtml(current.selectedPackageOtjid)}` : 'Registered schedule';
  body.innerHTML = `<section class="detail-event"><h3>${selectedSectionLabel}</h3>
    <div class="detail-grid"><span>Open seats / capacity</span><strong>${escapeHtml(current.seatsAvailable)}/${escapeHtml(current.seatsTotal)}</strong>
    <span>Total waitlist</span><strong>${escapeHtml(current.waitlistTotal ?? '—')}</strong>
    <span>Professor</span><strong>${escapeHtml(current.instructor || 'Staff')}</strong>
    <span>Section status</span><strong>${escapeHtml(current.status || '—')}</strong>
    <span>Section data checked</span><strong>${escapeHtml(formatTimestamp(current.sectionFetchedAt))}</strong></div>
    ${schedule ? `<div class="detail-section-list">${schedule}</div>` : '<div class="detail-empty">No schedule information is cached yet.</div>'}
    ${current.unavailable ? '<p class="req-error">This package is no longer listed. Your saved details are retained.</p>' : ''}
    ${current.sectionError ? `<p class="req-error">Last section refresh failed: ${escapeHtml(current.sectionError)}</p>` : ''}
    ${current.unavailable && current.availablePackages?.length ? '<button class="btn js-replace-section">Choose a different section</button>' : ''}</section>
    <div class="detail-refresh-indicator hidden" role="status"><span class="detail-refresh-label"></span><div class="detail-refresh-track"><span></span></div></div>
    <section class="detail-booking"><h3>Booking and dated meetings</h3>${bookingDetailHtml(current)}
      <p class="detail-updated">Booking data checked ${escapeHtml(formatTimestamp(current.bookingFetchedAt))}${current.bookingError ? ` - Last refresh failed: ${escapeHtml(current.bookingError)}` : ''}</p>
    </section>`;
  const replaceButton = body.querySelector('.js-replace-section');
  if (replaceButton) replaceButton.addEventListener('click', () => {
    const backdrop = body.closest('.modal-backdrop');
    if (backdrop) backdrop.querySelector('.modal-close').click();
    openSectionPicker(current, current.availablePackages, termForClass(current), current.id);
  });
}

function openClassDetails(cls) {
  if (selectedDetailId) return;
  selectedDetailId = cls.id;
  const current = planned.find((item) => item.id === cls.id) || cls;
  const backdrop = document.createElement('div');
  backdrop.className = 'modal-backdrop';
  backdrop.innerHTML = `<div class="modal details-modal">
    <div class="modal-head"><div class="modal-title">${escapeHtml(current.courseAbbr)} - ${escapeHtml(current.courseTitle)}</div><button class="modal-close" aria-label="Close">&times;</button></div>
    <div class="modal-body detail-body"></div>
    <div class="modal-foot"><button class="btn btn-primary js-detail-close">Close</button></div>
  </div>`;
  document.body.appendChild(backdrop);
  const close = () => {
    selectedDetailId = null;
    document.removeEventListener('keydown', keyHandler);
    backdrop.remove();
  };
  backdrop.querySelector('.modal-close').addEventListener('click', close);
  backdrop.querySelector('.js-detail-close').addEventListener('click', close);
  backdrop.addEventListener('click', (event) => { if (event.target === backdrop) close(); });
  const keyHandler = (event) => { if (event.key === 'Escape') close(); };
  document.addEventListener('keydown', keyHandler);
  const body = backdrop.querySelector('.detail-body');
  const needsBookingRefresh = !current.bookingFetchedAt && !current.bookingDetails?.fetchedAt;
  renderClassDetailsBody(body, current.id);
  if (needsBookingRefresh) refreshClassInfo(current.id);
}

function formatTimestamp(value) {
  if (!value) return 'Never';
  return new Intl.DateTimeFormat('en-US', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value));
}

function refreshMetaLabel(run) {
  if (!run?.startedAt) return 'Class details have not been refreshed yet.';
  if (!run.finishedAt) return `Refresh started ${formatTimestamp(run.startedAt)} (${run.completed || 0}/${run.total} in progress)`;
  if (run.cancelled) return `Refresh stopped ${formatTimestamp(run.finishedAt)} (${run.completed || 0}/${run.total} classes completed)`;
  return `Last refresh: ${formatTimestamp(run.startedAt)} (${Math.max(0, run.total - run.errors)}/${run.total} complete)`;
}

function showRefreshStatus(message, error = false, progressValue = null) {
  const status = document.getElementById('refresh-status');
  if (!status) return;
  const statusText = document.getElementById('refresh-status-text');
  if (statusText) statusText.textContent = message;
  status.classList.toggle('hidden', !message);
  status.classList.toggle('danger', error);
  const progress = document.getElementById('refresh-progress');
  const fill = document.getElementById('refresh-progress-fill');
  if (progress && fill) {
    const hasProgress = progressValue !== null && progressValue !== undefined;
    const bounded = Math.max(0, Math.min(100, Number(progressValue) || 0));
    const showBar = Boolean(message) && hasProgress;
    progress.classList.toggle('hidden', !showBar);
    status.classList.toggle('has-progress', showBar);
    status.classList.remove('state-progressing', 'state-complete', 'state-error');
    if (showBar) {
      let state = 'state-progressing';
      if (error || /error|stopped|[1-9]\d*\s+need attention/i.test(message)) state = 'state-error';
      else if (bounded >= 100) state = 'state-complete';
      status.classList.add(state);
    }
    progress.setAttribute('aria-valuenow', String(bounded));
    fill.style.width = `${bounded}%`;
  }
}

function setClassRefreshButton(classId, isRefreshing) {
  const courseAbbr = planned.find((item) => item.id === classId)?.courseAbbr || 'class';
  document.querySelectorAll('.js-refresh-class').forEach((button) => {
    if (button.dataset.id !== classId) return;
    button.disabled = isRefreshing;
    button.classList.toggle('is-refreshing', isRefreshing);
    button.title = `${isRefreshing ? 'Refreshing' : 'Refresh'} ${courseAbbr} class info`;
    button.setAttribute('aria-label', button.title);
  });
}

function setDetailRefreshProgress(classId, active, percent = 0, message = '') {
  if (selectedDetailId !== classId) return;
  const indicator = document.querySelector('.details-modal .detail-refresh-indicator');
  if (!indicator) return;
  indicator.classList.toggle('hidden', !active);
  const label = indicator.querySelector('.detail-refresh-label');
  const fill = indicator.querySelector('.detail-refresh-track span');
  if (label) label.textContent = message;
  if (fill) fill.style.width = `${Math.max(0, Math.min(100, Number(percent) || 0))}%`;
}

async function refreshClassInfo(classId) {
  if (scheduleSyncActive) {
    showRefreshStatus('Wait for schedule sync to finish before refreshing a class.');
    return false;
  }
  const { scheduleSyncRun } = await chrome.storage.local.get('scheduleSyncRun');
  if (scheduleSyncRun?.startedAt && !scheduleSyncRun.finishedAt && Date.now() - scheduleSyncRun.startedAt < 30 * 60 * 1000) {
    showRefreshStatus('Schedule sync is running in another planner tab.');
    return false;
  }
  if (singleClassRefreshes.has(classId)) {
    setDetailRefreshProgress(classId, true, 12, `Refreshing ${planned.find((item) => item.id === classId)?.courseAbbr || 'class'}...`);
    return singleClassRefreshes.get(classId);
  }
  if (activeRefreshId || fullRefreshStarting) {
    setDetailRefreshProgress(classId, true, 0, 'This class is included in the current refresh...');
    return false;
  }
  const initialClass = planned.find((item) => item.id === classId);
  if (!initialClass) return false;
  const { lastRefreshRun: otherRun } = await chrome.storage.local.get('lastRefreshRun');
  if (singleClassRefreshes.has(classId)) return singleClassRefreshes.get(classId);
  if (activeRefreshId || fullRefreshStarting) {
    setDetailRefreshProgress(classId, true, 0, 'This class is included in the current refresh...');
    return false;
  }
  if (otherRun?.refreshId && otherRun.startedAt && !otherRun.finishedAt && Date.now() - otherRun.startedAt < 30 * 60 * 1000) {
    observedRefreshId = otherRun.refreshId;
    const stopButton = document.getElementById('stop-refresh');
    const refreshButton = document.getElementById('refresh-all');
    if (stopButton) {
      stopButton.classList.remove('hidden');
      stopButton.disabled = false;
    }
    if (refreshButton) refreshButton.disabled = true;
    setDetailRefreshProgress(classId, true, 0, 'Waiting for the current class refresh...');
    const progress = otherRun.total ? (otherRun.completed || 0) / otherRun.total * 100 : 0;
    showRefreshStatus('A class refresh is already running in another planner tab.', false, progress);
    return false;
  }
  const refreshId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const waiting = singleClassRefreshes.size > 0;
  const task = singleRefreshQueue.catch(() => undefined).then(async () => {
    setClassRefreshButton(classId, true);
    setDetailRefreshProgress(classId, true, 8, `Refreshing ${initialClass.courseAbbr}...`);
    showRefreshStatus(`Refreshing ${initialClass.courseAbbr}...`);
    let term = termForClass(initialClass);
    let sectionResult;
    let bookingResult;
    let packages = [];
    let pkg = null;
    const candidateTerms = initialClass.scheduleOnly ? scheduleTermCandidates(term) : [term];
    for (const candidateTerm of candidateTerms) {
      term = candidateTerm;
      try {
        sectionResult = await chrome.runtime.sendMessage({ type: 'getSections', moduleID: initialClass.moduleID, term, refreshId });
      } catch (error) {
        sectionResult = { error: error.message || 'network' };
      }
      if (!sectionResult?.error) {
        packages = groupSections(sectionResult.sections || []);
        pkg = packages.find((item) => item.otjid === initialClass.selectedPackageOtjid)
          || findPackageForEventIds(packages, new Set(initialClass.syncedEventIds || []), new Set(initialClass.syncedSections || []));
      }
      if (pkg || !initialClass.scheduleOnly || ['no-auth', 'auth-expired'].includes(sectionResult?.error)) break;
    }
    const sectionRows = pkg?.raw || planned.find((item) => item.id === classId)?._lastPkg?.raw || [];
    setDetailRefreshProgress(classId, true, 48, 'Refreshing booking and meeting details...');
    try {
      bookingResult = await chrome.runtime.sendMessage({
        type: 'getBookingDetails',
        moduleID: initialClass.moduleID,
        eventPkgObjid: pkg?.objid || initialClass.eventPkgObjid,
        term,
        refreshId,
      });
    } catch (error) {
      bookingResult = { error: error.message || 'network' };
    }
    setDetailRefreshProgress(classId, true, 82, 'Saving refreshed class info...');
    const now = Date.now();
    let failed = false;
    await updateStoredClass(classId, (stored) => {
      const next = { ...stored };
      if (sectionResult && !sectionResult.error) {
        next.sectionFetchedAt = now;
        next.sectionError = null;
        next.unavailable = !pkg;
        next.availablePackages = pkg ? [] : packages.map(({ raw, ...item }) => item);
        if (pkg) Object.assign(next, {
          academicYear: term.academicYear,
          academicPeriod: term.academicPeriod,
          selectedPackageOtjid: pkg.otjid,
          eventPkgObjid: pkg.objid,
          seatsAvailable: pkg.seatsAvailable,
          seatsTotal: pkg.seatsTotal,
          waitlistTotal: pkg.waitlistTotal,
          instructor: pkg.instructor,
          status: pkg.status,
          location: pkg.location,
          scheduleBlocks: pkg.scheduleBlocks,
          _lastPkg: pkg,
        });
        else failed = true;
      } else {
        next.sectionError = [sectionResult?.error, sectionResult?.message].filter(Boolean).join(': ') || 'Section refresh failed';
        failed = true;
      }
      if (bookingResult && !bookingResult.error) {
        next.bookingFetchedAt = now;
        next.bookingError = null;
        next.bookingDetails = { events: normalizeBooking(bookingResult.events, sectionRows), fetchedAt: now };
        next.registered = bookingEventsContainRegistration(bookingResult.events);
        next.registeredFetchedAt = now;
      } else {
        next.bookingError = [bookingResult?.error, bookingResult?.message].filter(Boolean).join(': ') || 'Booking refresh failed';
        failed = true;
      }
      return next;
    });
    if (['no-auth', 'auth-expired'].includes(sectionResult?.error) || ['no-auth', 'auth-expired'].includes(bookingResult?.error)) showAuthBanner('expired');
    await chrome.runtime.sendMessage({ type: 'finishRefresh', refreshId }).catch(() => undefined);
    const updatedClass = planned.find((item) => item.id === classId);
    if (selectedDetailId === classId) {
      const body = document.querySelector('.details-modal .detail-body');
      if (body) renderClassDetailsBody(body, classId);
    }
    setDetailRefreshProgress(classId, true, 100, failed ? 'Refresh finished with errors.' : 'Class info refreshed.');
    showRefreshStatus(failed ? `Refresh finished with errors for ${initialClass.courseAbbr}.` : `Refreshed ${initialClass.courseAbbr}.`, failed);
    return !failed && Boolean(updatedClass);
  }).catch((error) => {
    showRefreshStatus(`Could not refresh class info: ${error.message || 'unknown error'}`, true);
    return false;
  }).finally(() => {
    singleClassRefreshes.delete(classId);
    setClassRefreshButton(classId, false);
    if (selectedDetailId === classId) setDetailRefreshProgress(classId, false);
  });
  singleClassRefreshes.set(classId, task);
  singleRefreshQueue = task.catch(() => undefined);
  setClassRefreshButton(classId, true);
  if (waiting) setDetailRefreshProgress(classId, true, 0, 'Waiting for the current class refresh...');
  return task;
}

async function refreshAllClasses() {
  if (scheduleSyncActive) {
    showRefreshStatus('Wait for schedule sync to finish before refreshing class info.');
    return;
  }
  const { scheduleSyncRun } = await chrome.storage.local.get('scheduleSyncRun');
  if (scheduleSyncRun?.startedAt && !scheduleSyncRun.finishedAt && Date.now() - scheduleSyncRun.startedAt < 30 * 60 * 1000) {
    showRefreshStatus('Schedule sync is running in another planner tab.');
    return;
  }
  if (activeRefreshId || fullRefreshStarting) return;
  if (singleClassRefreshes.size) {
    showRefreshStatus('A class refresh is already running. Try again when it finishes.');
    return;
  }
  fullRefreshStarting = true;
  const { lastRefreshRun: previousRun } = await chrome.storage.local.get('lastRefreshRun');
  if (previousRun?.refreshId && previousRun.startedAt && !previousRun.finishedAt && Date.now() - previousRun.startedAt < 30 * 60 * 1000) {
    observedRefreshId = previousRun.refreshId;
    const stopButton = document.getElementById('stop-refresh');
    if (stopButton) {
      stopButton.classList.remove('hidden');
      stopButton.disabled = false;
    }
    const refreshButton = document.getElementById('refresh-all');
    if (refreshButton) refreshButton.disabled = true;
    const progress = previousRun.total ? (previousRun.completed || 0) / previousRun.total * 100 : 0;
    showRefreshStatus('A class refresh is already running in another planner tab.', false, progress);
    fullRefreshStarting = false;
    return;
  }
  if (!planned.length) {
    showRefreshStatus('Add a class before refreshing class info.');
    fullRefreshStarting = false;
    return;
  }
  const button = document.getElementById('refresh-all');
  const stopButton = document.getElementById('stop-refresh');
  const classes = [...planned];
  const startedAt = Date.now();
  const refreshId = `${startedAt}-${Math.random().toString(36).slice(2, 8)}`;
  activeRefreshId = refreshId;
  fullRefreshStarting = false;
  observedRefreshId = null;
  refreshStopRequested = false;
  const run = { refreshId, startedAt, finishedAt: null, total: classes.length, completed: 0, errors: 0 };
  await chrome.storage.local.set({ lastRefreshRun: run });
  if (button) button.disabled = true;
  if (stopButton) {
    stopButton.classList.remove('hidden');
    stopButton.disabled = false;
  }
  showRefreshStatus(`Refreshing 1 of ${classes.length}: ${classes[0].courseAbbr}...`, false, 0);
  const sectionCache = new Map();
  let authFailed = false;
  for (let index = 0; index < classes.length; index++) {
    if (refreshStopRequested) break;
    const cls = classes[index];
    showRefreshStatus(`Refreshing ${index + 1} of ${classes.length}: ${cls.courseAbbr}...`, false, run.completed / run.total * 100);
    let term = termForClass(cls);
    let sectionResult = null;
    let packages = [];
    let pkg = null;
    const candidateTerms = cls.scheduleOnly ? scheduleTermCandidates(term) : [term];
    for (const candidateTerm of candidateTerms) {
      term = candidateTerm;
      const cacheKey = `${cls.moduleID}|${term.academicYear}|${term.academicPeriod}`;
      if (!sectionCache.has(cacheKey)) {
        try {
          sectionCache.set(cacheKey, await chrome.runtime.sendMessage({ type: 'getSections', moduleID: cls.moduleID, term, refreshId }));
        } catch (error) {
          sectionCache.set(cacheKey, { error: error.message || 'network' });
        }
      }
      sectionResult = sectionCache.get(cacheKey);
      if (sectionResult?.error === 'cancelled') refreshStopRequested = true;
      if (refreshStopRequested) break;
      if (!sectionResult?.error) {
        packages = groupSections(sectionResult.sections || []);
        pkg = packages.find((item) => item.otjid === cls.selectedPackageOtjid)
          || findPackageForEventIds(packages, new Set(cls.syncedEventIds || []), new Set(cls.syncedSections || []));
      }
      if (pkg || !cls.scheduleOnly || ['no-auth', 'auth-expired'].includes(sectionResult?.error)) break;
    }
    if (refreshStopRequested) break;
    const bookingResult = await chrome.runtime.sendMessage({
      type: 'getBookingDetails', moduleID: cls.moduleID, eventPkgObjid: pkg?.objid || cls.eventPkgObjid, term, refreshId,
    }).catch((error) => ({ error: error.message || 'network' }));
    if (bookingResult?.error === 'cancelled') refreshStopRequested = true;
    if (refreshStopRequested) break;
    const now = Date.now();
    if (['no-auth', 'auth-expired'].includes(sectionResult?.error) || ['no-auth', 'auth-expired'].includes(bookingResult?.error)) authFailed = true;
    let failed = false;
    await updateStoredClass(cls.id, (stored) => {
      const next = { ...stored };
      let sectionRows = stored._lastPkg?.raw || [];
      if (sectionResult && !sectionResult.error) {
        next.sectionFetchedAt = now;
        next.sectionError = null;
        next.unavailable = !pkg && !stored.scheduleOnly;
        next.availablePackages = pkg ? [] : packages.map(({ raw, ...item }) => item);
        if (pkg) Object.assign(next, {
          academicYear: term.academicYear, academicPeriod: term.academicPeriod,
          selectedPackageOtjid: pkg.otjid, eventPkgObjid: pkg.objid, seatsAvailable: pkg.seatsAvailable, seatsTotal: pkg.seatsTotal,
          waitlistTotal: pkg.waitlistTotal, instructor: pkg.instructor, status: pkg.status,
          location: pkg.location, scheduleBlocks: pkg.scheduleBlocks, _lastPkg: pkg,
        });
        if (pkg) sectionRows = pkg.raw || [];
        else failed = true;
      } else {
        next.sectionError = [sectionResult?.error, sectionResult?.message].filter(Boolean).join(': ') || 'Section refresh failed';
        failed = true;
      }
      if (!bookingResult?.error) {
        next.bookingFetchedAt = now;
        next.bookingError = null;
        next.bookingDetails = { events: normalizeBooking(bookingResult.events, sectionRows), fetchedAt: now };
        next.registered = bookingEventsContainRegistration(bookingResult.events);
        next.registeredFetchedAt = now;
      } else {
        next.bookingError = [bookingResult.error, bookingResult.message].filter(Boolean).join(': ');
        failed = true;
      }
      return next;
    });
    run.completed++;
    if (failed) run.errors++;
    await chrome.storage.local.set({ lastRefreshRun: { ...run } });
    showRefreshStatus(`Refreshed ${run.completed} of ${run.total} classes.`, false, run.completed / run.total * 100);
  }
  run.finishedAt = Date.now();
  run.cancelled = refreshStopRequested;
  await chrome.storage.local.set({ lastRefreshRun: run });
  chrome.runtime.sendMessage({ type: 'finishRefresh', refreshId }).catch(() => undefined);
  if (button) button.disabled = false;
  if (stopButton) stopButton.classList.add('hidden');
  activeRefreshId = null;
  if (authFailed) showAuthBanner('expired');
  showRefreshStatus(refreshStopRequested
    ? `Refresh stopped. ${run.completed} of ${run.total} classes completed.`
    : `Refresh complete: ${run.completed - run.errors}/${run.total} classes fully refreshed; ${run.errors} need attention.`, false,
  run.total ? run.completed / run.total * 100 : 100);
}

function stopClassRefresh() {
  const refreshId = activeRefreshId || observedRefreshId;
  if (!refreshId || refreshStopRequested) return;
  const stoppingRemoteRun = !activeRefreshId && observedRefreshId === refreshId;
  refreshStopRequested = true;
  const stopButton = document.getElementById('stop-refresh');
  if (stopButton) stopButton.disabled = true;
  showRefreshStatus('Stopping the current request…');
  chrome.runtime.sendMessage({ type: 'cancelRefresh', refreshId }).then(async () => {
    if (!stoppingRemoteRun) return;
    const { lastRefreshRun } = await chrome.storage.local.get('lastRefreshRun');
    if (lastRefreshRun?.refreshId !== refreshId) return;
    if (lastRefreshRun.finishedAt) {
      chrome.runtime.sendMessage({ type: 'finishRefresh', refreshId }).catch(() => undefined);
      return;
    }
    const run = { ...lastRefreshRun, finishedAt: Date.now(), cancelled: true };
    await chrome.storage.local.set({ lastRefreshRun: run });
  }).catch(() => undefined);
}

// ---------- Auth banner ----------
function showAuthBanner(mode, extra, strategy = null, reauthStep = null) {
  const banner = document.getElementById('auth-banner');
  const text = document.getElementById('auth-text');
  const button = document.getElementById('reauth-btn');
  banner.classList.remove('hidden', 'danger');
  banner.dataset.reauthPhase = mode;
  button.classList.toggle('hidden', ['checking', 'automating', 'duo-opening', 'verifying'].includes(mode));
  button.textContent = mode === 'pending' ? 'Open sign-in' : 'Re-auth';
  if (mode === 'checking') {
    text.textContent = 'Checking TSS connection...';
  } else if (mode === 'automating') {
    const stepMessages = {
      'helper-loaded': 'UCSD sign-in page loaded. Locating its controls...',
      'chooser-found': 'UCSD SSO option found. Continuing sign-in...',
      'credential-form-found': 'UCSD credential form found. Preparing sign-in...',
      'credentials-submitting': 'Submitting UCSD credentials. The real Duo page will open if needed.',
    };
    text.textContent = stepMessages[reauthStep]
      || 'Signing in through UCSD. The real Duo page will open if UCSD requests it.';
  } else if (mode === 'duo-opening') {
    text.textContent = 'Opening the UCSD Duo prompt...';
  } else if (mode === 'pending') {
    text.textContent = strategy === 'custom'
      ? 'Complete the UCSD Duo prompt in the popup. It will close after TSS confirms the session.'
      : 'Finish SIS/UCSD sign-in in the browser window and approve Duo.';
  } else if (mode === 'verifying') {
    text.textContent = 'Checking the new TSS session...';
  } else if (mode === 'failed') {
    banner.classList.add('danger');
    text.textContent = extra
      ? `Re-auth failed: ${extra}. Use Re-auth to try again.`
      : 'Could not use the TSS session. Use Re-auth to try again.';
  } else if (mode === 'cancelled') {
    text.textContent = 'Sign-in flow closed before TSS connected. Use Re-auth to try again.';
  } else if (mode === 'expired') {
    banner.classList.add('danger');
    text.textContent = 'Your TSS session has expired. Use Re-auth to fetch class info. Your planned classes are preserved.';
  } else if (mode === 'not-connected') {
    text.textContent = 'Not connected to TSS. Use Re-auth to sign in; your planned classes are kept.';
  } else {
    banner.classList.add('danger');
    text.textContent = `Search failed: ${extra || 'unknown error'}. Use Re-auth if your TSS session expired.`;
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
          <span class="result-abbr">${escapeHtml(r.courseAbbr)}</span>
          <span class="result-title">${escapeHtml(r.courseTitle)}</span>
        </div>
        <div class="result-meta">
          <span class="chip">${escapeHtml(r.credits)} cr</span>
          <span class="chip chip-dept">${escapeHtml(r.departmentAbbr)}</span>
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

function normalizeSearchQuery(value) {
  const query = String(value || '').trim();
  const match = query.match(/^([a-z]+)\s*-?\s*(\d{1,3})([a-z]?)$/i);
  if (!match) return query;
  return `${match[1].toUpperCase()}-${match[2].padStart(3, '0')}${match[3].toUpperCase()}`;
}

async function doSearch() {
  const input = document.getElementById('search-input');
  const q = normalizeSearchQuery(input.value);
  if (!q) {
    showSearchResults(false);
    return;
  }
  input.value = q;
  await loadTerm();
  renderSearchLoading();
  let resp;
  try {
    resp = await sendRuntimeMessage({ type: 'searchClasses', term: currentTerm, query: q }, 30000);
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

// ---------- Requirements ----------
// Parses a requirement text line like "PHYS-002A - Physics-Mechanics with a 'D' or higher"
// into { type: 'PHYS', classCode: '002A', description: "Physics-Mechanics with a 'D' or higher" }
function parseRequirement(text) {
  const trimmed = text.trim();
  const m = trimmed.match(/^([A-Z]+)-(\d+[A-Z]*)\s*-\s*(.+)$/);
  if (!m) return { raw: trimmed, type: null, classCode: null, description: trimmed };
  return { raw: trimmed, type: m[1], classCode: m[2], description: m[3] };
}

// Builds a tree from flat prereq nodes (parent_id linking).
// Group nodes are connectors like "1 of the following:"; leaf nodes are course requirements.
function buildPrereqTree(nodes) {
  const byId = {};
  const roots = [];
  for (const n of nodes) {
    byId[n.id] = { ...n, parsed: null, children: [] };
  }
  for (const n of nodes) {
    const node = byId[n.id];
    if (n.parent_id && byId[n.parent_id]) {
      byId[n.parent_id].children.push(node);
    } else {
      roots.push(node);
    }
    // If the text looks like a course requirement, parse it
    if (/\b[A-Z]+-\d+/.test(n.text)) {
      node.parsed = parseRequirement(n.text);
    }
  }
  return roots;
}

function renderPrereqTree(nodes, depth) {
  let html = '';
  for (const node of nodes) {
    const isGroup = node.children.length > 0;
    if (isGroup) {
      html += `<div class="req-group" style="margin-left:${depth * 16}px">${escapeHtml(node.text)}</div>`;
      html += renderPrereqTree(node.children, depth + 1);
    } else {
      const p = node.parsed;
      if (p && p.type) {
        html += `<div class="req-leaf" style="margin-left:${depth * 16}px">` +
          `<span class="req-course">${escapeHtml(p.type)}-${escapeHtml(p.classCode)}</span>` +
          `<span class="req-desc">${escapeHtml(p.description)}</span></div>`;
      } else {
        html += `<div class="req-leaf" style="margin-left:${depth * 16}px">${escapeHtml(node.text)}</div>`;
      }
    }
  }
  return html;
}

async function getCachedRequirements(moduleID) {
  const key = `req_${moduleID}`;
  const data = await chrome.storage.local.get(key);
  return data[key] || null;
}

async function setCachedRequirements(moduleID, requirements) {
  const key = `req_${moduleID}`;
  await chrome.storage.local.set({ [key]: { requirements, fetchedAt: Date.now() } });
}

async function fetchRequirements(moduleID) {
  return chrome.runtime.sendMessage({ type: 'getRequirements', moduleID });
}

function openRequirementsModal(cls) {
  const backdrop = document.createElement('div');
  backdrop.className = 'modal-backdrop';
  backdrop.innerHTML = `
    <div class="modal req-modal">
      <div class="modal-head">
        <div class="modal-title">Requirements — ${escapeHtml(cls.courseAbbr)}</div>
        <button class="modal-close">&times;</button>
      </div>
      <div class="modal-body req-body">
        <div class="req-loading">Loading…</div>
      </div>
      <div class="modal-foot">
        <button class="btn js-req-refetch">Re-fetch Requirements</button>
        <button class="btn btn-primary js-req-close">Close</button>
      </div>
    </div>`;
  document.body.appendChild(backdrop);

  const close = () => backdrop.remove();
  backdrop.querySelector('.modal-close').addEventListener('click', close);
  backdrop.querySelector('.js-req-close').addEventListener('click', close);
  backdrop.addEventListener('click', (e) => { if (e.target === backdrop) close(); });

  const body = backdrop.querySelector('.req-body');

  async function renderRequirements(requirements, fromCache) {
    if (!requirements || requirements.length === 0) {
      body.innerHTML = '<div class="req-empty">No prerequisites found for this course.</div>';
      return;
    }
    const tree = buildPrereqTree(requirements);
    const fetchedNote = fromCache
      ? `<div class="req-cached-note">Cached — click "Re-fetch" to update</div>`
      : '';
    body.innerHTML = fetchedNote + renderPrereqTree(tree, 0);
  }

  async function loadAndRender(force) {
    body.innerHTML = '<div class="req-loading">Loading…</div>';
    if (!force) {
      const cached = await getCachedRequirements(cls.moduleID);
      if (cached) {
        renderRequirements(cached.requirements, true);
        return;
      }
    }
    const resp = await fetchRequirements(cls.moduleID);
    if (resp.error === 'no-auth' || resp.error === 'auth-expired') {
      body.innerHTML = '<div class="req-error">Your TSS session has expired. Log into TSS and try again.</div>';
      return;
    }
    if (resp.error) {
      body.innerHTML = `<div class="req-error">Failed to fetch requirements (${resp.error}${resp.status ? ' ' + resp.status : ''}).</div>`;
      return;
    }
    await setCachedRequirements(cls.moduleID, resp.requirements);
    renderRequirements(resp.requirements, false);
  }

  backdrop.querySelector('.js-req-refetch').addEventListener('click', () => loadAndRender(true));

  loadAndRender(false);
}

// ---------- Section picker modal ----------
function openSectionPicker(course, packages, term, replaceClassId = null) {
  const backdrop = document.createElement('div');
  backdrop.className = 'modal-backdrop';

  if (packages.length === 0) {
    backdrop.innerHTML = `
      <div class="modal">
        <div class="modal-head">
          <div class="modal-title">${escapeHtml(course.courseAbbr)} — No sections</div>
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
        .map((m) => `<span class="method-tag ${meetingTypeClass(m)}">${escapeHtml(m)}</span>`)
        .join('');
      const detailLines = pkg.scheduleBlocks
        .map((b) => `<span>${escapeHtml(b.isFinal ? `${finalDateLabel(b)} ${finalTimeLabel(b)}` : `${b.day} ${b.start}-${b.end}`)} — ${escapeHtml(b.location)} (${escapeHtml(b.type)})</span>`)
        .join('');
      const seatsCls = seatsClass(pkg.seatsAvailable, pkg.seatsTotal);
      return `
        <div class="package-option" data-idx="${i}">
          <div class="package-head">
            <span class="package-id">${escapeHtml(pkg.displayID || pkg.otjid)} — ${escapeHtml(pkg.pkgText)}</span>
            <div class="package-methods">${methodTags}</div>
          </div>
          <div class="package-detail">
            ${detailLines}
            <span>Open seats: <span class="${seatsCls}">${pkg.seatsAvailable}/${pkg.seatsTotal}</span> · Total waitlist: ${pkg.waitlistTotal} · ${escapeHtml(pkg.instructor)}</span>
          </div>
        </div>`;
    })
    .join('');

  backdrop.innerHTML = `
    <div class="modal">
      <div class="modal-head">
        <div class="modal-title">${escapeHtml(course.courseAbbr)} — Choose a Section</div>
        <button class="modal-close">&times;</button>
      </div>
      <div class="modal-body">${optionsHtml}</div>
      <div class="modal-foot">
        <button class="btn js-modal-cancel">Cancel</button>
        <button class="btn btn-primary js-modal-add" disabled>Add to Plan</button>
      </div>
    </div>`;
  document.body.appendChild(backdrop);

  let selectedIdx = null;
  backdrop.querySelectorAll('.package-option').forEach((opt) => {
    opt.addEventListener('click', () => {
      backdrop.querySelectorAll('.package-option').forEach((o) => o.classList.remove('selected'));
      opt.classList.add('selected');
      selectedIdx = parseInt(opt.dataset.idx, 10);
      backdrop.querySelector('.js-modal-add').disabled = false;
    });
  });

  const close = () => backdrop.remove();
  backdrop.querySelector('.modal-close').addEventListener('click', close);
  backdrop.querySelector('.js-modal-cancel').addEventListener('click', close);
  backdrop.addEventListener('click', (e) => { if (e.target === backdrop) close(); });

  backdrop.querySelector('.js-modal-add').addEventListener('click', () => {
    if (selectedIdx === null) {
      return;
    }
    const pkg = packages[selectedIdx];
    const existing = replaceClassId ? planned.find((item) => item.id === replaceClassId) : null;
    const plannedClass = {
      ...(existing || {}),
      id: existing?.id || 'p-' + Date.now() + '-' + Math.random().toString(36).slice(2, 7),
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
      waitlistTotal: pkg.waitlistTotal,
      instructor: pkg.instructor,
      status: pkg.status,
      location: pkg.location,
      scheduleBlocks: pkg.scheduleBlocks,
      _lastPkg: pkg,
      sectionFetchedAt: Date.now(),
      sectionError: null,
      bookingDetails: null,
      bookingFetchedAt: null,
      bookingError: null,
      registered: false,
      registeredFetchedAt: null,
      syncedEventIds: [],
      syncedSections: [],
      syncedFromSchedule: false,
      scheduleOnly: false,
      availablePackages: [],
      unavailable: false,
      addedAt: existing?.addedAt || Date.now(),
    };
    chrome.storage.local.get('plannedClasses').then(({ plannedClasses }) => {
      planned = Array.isArray(plannedClasses) ? plannedClasses : [];
      const index = planned.findIndex((item) => item.id === plannedClass.id);
      if (index >= 0) planned[index] = plannedClass;
      else planned.push(plannedClass);
      return chrome.storage.local.set({ plannedClasses: planned });
    }).then(renderAll);
    close();
  });
}

// ---------- Init ----------
async function checkAuth(forcePersonalRefresh = false) {
  const request = ++authCheckSequence;
  let status;
  try {
    status = await sendRuntimeMessage({ type: 'getSessionStatus' });
  } catch {
    status = { connected: false, error: 'background' };
  }
  if (request !== authCheckSequence) return;
  if (['automating', 'duo-opening', 'pending', 'verifying'].includes(status?.reauthPhase)) {
    showAuthBanner(status.reauthPhase, status.reauthError, status.reauthStrategy, status.reauthStep);
  } else if (status?.connected) {
    hideAuthBanner();
  } else if (status?.reauthPhase === 'failed' || status?.reauthPhase === 'cancelled') {
    showAuthBanner(status.reauthPhase, status.reauthError);
  } else if (status?.error === 'auth-expired') {
    showAuthBanner('expired');
  } else if (status?.error === 'no-auth') {
    showAuthBanner('not-connected');
  } else if (status?.error === 'background') {
    showAuthBanner('failed', 'No response from the background worker. Reload the extension and try again.');
  } else if (status?.error) {
    showAuthBanner('failed');
  } else {
    showAuthBanner('not-connected');
  }
  const capture = document.getElementById('capture-meta');
  if (capture) capture.textContent = `${status?.connected ? 'Connected to TSS' : 'Not connected to TSS'} · Last session capture: ${formatTimestamp(status?.capturedAt)}`;
  if (status?.connected) refreshPersonalDetails(forcePersonalRefresh).catch(() => undefined);
  return status;
}

document.addEventListener('DOMContentLoaded', async () => {
  const reauthModeToggle = document.getElementById('reauth-mode-toggle');
  let reauthUseOfficialPopup = false;
  const renderReauthMode = (useOfficialPopup) => {
    reauthUseOfficialPopup = useOfficialPopup === true;
    reauthModeToggle.textContent = reauthUseOfficialPopup ? 'O' : 'I';
    reauthModeToggle.dataset.reauthMode = reauthUseOfficialPopup ? 'official' : 'intercept';
    reauthModeToggle.classList.toggle('official', reauthUseOfficialPopup);
    reauthModeToggle.setAttribute('aria-checked', String(reauthUseOfficialPopup));
    const method = reauthUseOfficialPopup ? 'Official popup' : 'Intercept';
    reauthModeToggle.setAttribute('aria-label', `Re-auth method: ${method}`);
    reauthModeToggle.title = `Re-auth method: ${method} (${reauthUseOfficialPopup ? 'O' : 'I'}). Click to switch.`;
  };
  try {
    const { reauthUseOfficialPopup } = await chrome.storage.local.get('reauthUseOfficialPopup');
    renderReauthMode(reauthUseOfficialPopup);
  } catch {
    renderReauthMode(false);
  }

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes.auth) {
      const accountChanged = changes.auth.oldValue?.cookie !== changes.auth.newValue?.cookie;
      checkAuth(accountChanged);
    } else if (area === 'session' && (changes.reauthFlow || changes.authFault)) {
      checkAuth();
    }
    if (area === 'local' && changes.reauthUseOfficialPopup) {
      renderReauthMode(changes.reauthUseOfficialPopup.newValue === true);
    }
  });
  window.addEventListener('focus', checkAuth);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') checkAuth();
  });
  showAuthBanner('checking');
  checkAuth();

  document.getElementById('auth-diagnostics-btn').addEventListener('click', async (event) => {
    const button = event.currentTarget;
    const details = document.getElementById('auth-diagnostics');
    const output = document.getElementById('auth-diagnostics-output');
    button.disabled = true;
    button.textContent = 'Reading diagnostics...';
    try {
      const report = await sendRuntimeMessage({ type: 'getReauthDiagnostics' });
      output.value = JSON.stringify(report || { error: 'no-worker-response' }, null, 2);
      details.classList.remove('hidden');
      try {
        await navigator.clipboard.writeText(output.value);
        button.textContent = 'Diagnostics copied';
      } catch {
        details.open = true;
        output.focus();
        output.select();
        button.textContent = 'Select and copy diagnostics below';
      }
    } catch {
      output.value = 'The running extension worker did not return diagnostics.';
      details.classList.remove('hidden');
      details.open = true;
      button.textContent = 'Retry sign-in diagnostics';
    } finally {
      button.disabled = false;
    }
  });

  const reauthDialog = document.getElementById('reauth-dialog');
  const reauthForm = document.getElementById('reauth-form');
  const reauthUsername = document.getElementById('reauth-username');
  const reauthPassword = document.getElementById('reauth-password');
  const reauthFormError = document.getElementById('reauth-form-error');
  const reauthSubmit = reauthForm.querySelector('button[type="submit"]');
  reauthModeToggle.addEventListener('click', () => {
    const previous = reauthUseOfficialPopup;
    const next = !previous;
    renderReauthMode(next);
    chrome.storage.local.set({ reauthUseOfficialPopup: next }).catch(() => renderReauthMode(previous));
  });

  document.getElementById('reauth-btn').addEventListener('click', async () => {
    if (document.getElementById('auth-banner').dataset.reauthPhase === 'pending') {
      try {
        await sendRuntimeMessage({ type: 'startReauth' });
      } catch {
        showAuthBanner('failed', 'Could not contact the background worker. Reload the extension and try again.');
      }
      return;
    }

    if (reauthUseOfficialPopup) {
      showAuthBanner('pending', null, 'official');
      try {
        const result = await sendRuntimeMessage({ type: 'startReauth' });
        if (!['pending', 'verifying', 'automating', 'duo-opening'].includes(result?.phase)) {
          showAuthBanner('failed', result?.detail || 'Could not open the UCSD sign-in window.');
        }
      } catch {
        showAuthBanner('failed', 'Could not contact the background worker. Reload the extension and try again.');
      }
      return;
    }

    reauthFormError.textContent = '';
    reauthFormError.classList.add('hidden');
    reauthDialog.showModal();
    reauthUsername.focus();
  });

  document.getElementById('reauth-cancel').addEventListener('click', () => reauthDialog.close());
  reauthDialog.addEventListener('close', () => {
    reauthUsername.value = '';
    reauthPassword.value = '';
    reauthFormError.textContent = '';
    reauthFormError.classList.add('hidden');
  });

  reauthForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (reauthForm.dataset.busy === 'true') return;
    reauthForm.dataset.busy = 'true';
    reauthSubmit.disabled = true;
    reauthFormError.textContent = '';
    reauthFormError.classList.add('hidden');

    let username = reauthUsername.value.trim();
    let password = reauthPassword.value;
    if (!username || !password) {
      reauthFormError.textContent = 'Enter your UCSD username and password.';
      reauthFormError.classList.remove('hidden');
      reauthForm.dataset.busy = 'false';
      reauthSubmit.disabled = false;
      return;
    }

    try {
      const responsePromise = sendRuntimeMessage({ type: 'startCustomReauth', username, password });
      username = '';
      password = '';
      reauthUsername.value = '';
      reauthPassword.value = '';
      reauthDialog.close();
      showAuthBanner('automating', null, 'custom');

      const result = await responsePromise;
      if (!['automating', 'duo-opening', 'pending', 'verifying'].includes(result?.phase)) {
        showAuthBanner('failed', result?.detail || 'Could not start the custom UCSD sign-in flow.');
      }
    } catch {
      username = '';
      password = '';
      reauthFormError.textContent = 'Could not send the sign-in request to the extension. Reload the extension and try again.';
      reauthFormError.classList.remove('hidden');
      if (reauthDialog.open) {
        reauthForm.dataset.busy = 'false';
        reauthSubmit.disabled = false;
      } else {
        showAuthBanner('failed', 'Could not contact the background worker. Reload the extension and try again.');
      }
    } finally {
      username = '';
      password = '';
      reauthForm.dataset.busy = 'false';
      reauthSubmit.disabled = false;
    }
  });

  isPlanner = document.body.classList.contains('full-planner');
  planned = await loadPlanned();
  await loadTerm();
  const { personalDetails } = await chrome.storage.local.get('personalDetails');
  renderPersonalProfile(personalDetails || null);
  document.getElementById('term-badge').textContent = termBadge(currentTerm);
  const { lastRefreshRun } = await chrome.storage.local.get('lastRefreshRun');
  renderAll();
  const refreshMeta = document.getElementById('refresh-meta');
  if (refreshMeta) refreshMeta.textContent = refreshMetaLabel(lastRefreshRun);

  const plannerButton = document.getElementById('open-planner');
  if (plannerButton) plannerButton.addEventListener('click', () => chrome.tabs.create({ url: chrome.runtime.getURL('planner.html') }));
  const profileWrap = document.querySelector('.profile-menu-wrap');
  const profileToggle = document.getElementById('profile-toggle');
  const profilePanel = document.getElementById('profile-panel');
  const closeProfile = () => {
    if (!profileToggle || !profilePanel) return;
    profileToggle.setAttribute('aria-expanded', 'false');
    profilePanel.classList.add('hidden');
  };
  if (profileToggle && profilePanel) {
    profileToggle.addEventListener('click', (event) => {
      event.stopPropagation();
      const open = profileToggle.getAttribute('aria-expanded') !== 'true';
      profileToggle.setAttribute('aria-expanded', String(open));
      profilePanel.classList.toggle('hidden', !open);
    });
    document.addEventListener('click', (event) => {
      if (!profileWrap?.contains(event.target)) closeProfile();
    });
    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') closeProfile();
    });
  }
  const themeToggle = document.getElementById('theme-toggle');
  if (themeToggle) {
    const syncThemeToggle = () => {
      const light = document.documentElement.classList.contains('light-mode');
      themeToggle.setAttribute('aria-checked', String(light));
    };
    themeToggle.addEventListener('click', () => {
      const light = document.documentElement.classList.toggle('light-mode');
      themeToggle.setAttribute('aria-checked', String(light));
      chrome.storage.local.set({ theme: light ? 'light' : 'dark' });
    });
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area === 'local' && changes.theme) syncThemeToggle();
    });
    syncThemeToggle();
  }
  const refreshButton = document.getElementById('refresh-all');
  if (refreshButton) refreshButton.addEventListener('click', () => {
    if (isPlanner) refreshAllClasses();
    else chrome.tabs.create({ url: `${chrome.runtime.getURL('planner.html')}?refresh=all` });
  });
  const syncButton = document.getElementById('sync-schedule');
  if (syncButton) syncButton.addEventListener('click', syncSchedule);
  const stopButton = document.getElementById('stop-refresh');
  if (stopButton) stopButton.addEventListener('click', stopClassRefresh);

  const input = document.getElementById('search-input');
  const searchBtn = document.getElementById('search-btn');
  searchBtn.addEventListener('click', doSearch);
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') doSearch(); });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    if (changes.personalDetails) renderPersonalProfile(changes.personalDetails.newValue || null);
    if (changes.plannedClasses) {
      planned = Array.isArray(changes.plannedClasses.newValue) ? changes.plannedClasses.newValue : [];
      renderAll();
      if (selectedDetailId && !singleClassRefreshes.has(selectedDetailId)) {
        const body = document.querySelector('.details-modal .detail-body');
        if (body) renderClassDetailsBody(body, selectedDetailId);
      }
    }
    if (changes.currentTerm) {
      currentTerm = changes.currentTerm.newValue || DEFAULT_TERM;
      document.getElementById('term-badge').textContent = termBadge(currentTerm);
    }
    if (changes.lastRefreshRun) {
      const run = changes.lastRefreshRun.newValue;
      if (refreshMeta && run) refreshMeta.textContent = refreshMetaLabel(run);
      if (observedRefreshId && run?.refreshId === observedRefreshId) {
        const progress = run.total ? (run.completed || 0) / run.total * 100 : 0;
        if (run.finishedAt) {
          observedRefreshId = null;
          refreshStopRequested = false;
          const refreshButton = document.getElementById('refresh-all');
          const stopButton = document.getElementById('stop-refresh');
          if (refreshButton) refreshButton.disabled = false;
          if (stopButton) stopButton.classList.add('hidden');
          showRefreshStatus(run.cancelled ? 'Refresh stopped in the other planner tab.' : 'Refresh finished in the other planner tab.', false, progress);
          if (selectedDetailId) setDetailRefreshProgress(selectedDetailId, false);
        } else {
          showRefreshStatus(`Refreshing classes in the other planner tab: ${run.completed || 0}/${run.total}`, false, progress);
        }
      }
    }
  });

  if (isPlanner && new URLSearchParams(location.search).get('refresh') === 'all') {
    history.replaceState(null, '', location.pathname);
    refreshAllClasses();
  }
});
