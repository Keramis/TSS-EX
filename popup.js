const DAYS = ['M', 'Tu', 'W', 'Th', 'F', 'Sa', 'Su'];
const DEFAULT_TERM = { academicYear: '2026', academicPeriod: '2' };
const PERIOD_CODE = { '1': 'FA', '2': 'WI', '3': 'SP', '4': 'SU' };

let planned = [];
let currentTerm = null;
let showFinals = false;
let isPlanner = false;
let selectedDetailId = null;
const detailRequests = new Set();

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (char) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[char]);
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

function parseSched(sched, type) {
  const blocks = [];
  if (!sched) return blocks;
  for (const line of sched.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const isFinal = /^final\s+examination/i.test(trimmed);
    // Finals have a date prefix: "Final Examination 12/09/2026 08:00 AM - 10:59 AM In Person @ ..."
    let m = trimmed.match(
      /^([A-Za-z]{1,2}(?:,\s*[A-Za-z]{1,2})*)\s+(\d{1,2}:\d{2}\s*[AP]M)\s*-\s*(\d{1,2}:\d{2}\s*[AP]M)\s+In\s+Person\s+@\s+(.+)$/i
    );
    if (!m && isFinal) {
      m = trimmed.match(
        /^Final\s+Examination\s+(\d{1,2}\/\d{1,2}\/\d{4})\s+(\d{1,2}:\d{2}\s*[AP]M)\s*-\s*(\d{1,2}:\d{2}\s*[AP]M)\s+In\s+Person\s+@\s+(.+)$/i
      );
      if (m) {
        // The final date is stored separately and converted to a weekday for display.
        blocks.push({
          day: 'Final',
          finalDate: m[1],
          start: to24h(m[2]),
          end: to24h(m[3]),
          location: m[4].trim(),
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
  if (!allBlocks.length) return { start: 8, end: 17, hourHeight: isPlanner ? 48 : 18 };
  if (isPlanner) {
    const min = Math.min(...allBlocks.map((b) => timeToMinutes(b.start)));
    const max = Math.max(...allBlocks.map((b) => timeToMinutes(b.end)));
    return { start: Math.min(7, Math.floor(min / 60)), end: Math.max(21, Math.ceil(max / 60)), hourHeight: 48 };
  }
  const min = Math.min(...allBlocks.map((b) => timeToMinutes(b.start)));
  const max = Math.max(...allBlocks.map((b) => timeToMinutes(b.end)));
  const start = Math.floor(min / 60);
  const end = Math.ceil(max / 60) || start + 1;
  return { start, end: Math.max(end, start + 1), hourHeight: Math.min(26, 210 / Math.max(1, end - start)) };
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
      const block = document.createElement('div');
      block.className = `block ${b.type.toLowerCase()}${isConflict ? ' conflict' : ''}`;
      block.style.top = `${top}px`;
      block.style.height = `${height}px`;
      const conflictNote = isConflict ? '\n⚠ Schedule overlap' : '';
      const finalNote = isFinalConflict ? '\n⚠ Final exam conflict' : '';
      block.title = `${cls.courseAbbr} ${b.type}\n${minutesToLabel(timeToMinutes(b.start))} - ${minutesToLabel(timeToMinutes(b.end))}\n${b.location}${conflictNote}${finalNote}`;
      block.textContent = cls.courseAbbr;
      if (isPlanner) block.title = `${block.title}\n${b.start}-${b.end} · ${b.location}`;
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

    const scheduleTags = (cls.scheduleBlocks || [])
      .filter((b) => showFinals || !b.isFinal)
      .map((b) => {
        const key = `${cls.id}|${b.day}|${b.start}|${b.end}`;
        const isBlockConflict = !b.isFinal && conflictBlockKeys.has(key);
        const label = b.isFinal
          ? `${finalDateLabel(b)} ${finalTimeLabel(b)} · ${b.location}`
          : `${b.day} ${b.start}-${b.end} · ${b.location}`;
        return `<span class="schedule-tag ${String(b.type).toLowerCase()}${isBlockConflict ? ' tag-conflict' : ''}">${escapeHtml(label)}</span>`;
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
          <span class="planned-card-abbr">${escapeHtml(cls.courseAbbr)}</span>
          <span class="planned-card-name">${escapeHtml(cls.courseTitle)}</span>
        </div>
        <div class="planned-card-actions">
          <button class="btn btn-small js-details" data-id="${escapeHtml(cls.id)}">Class details</button>
          <button class="btn btn-small js-requirements" data-id="${escapeHtml(cls.id)}">Requirements</button>
          <button class="btn btn-small btn-primary js-open" data-id="${escapeHtml(cls.id)}">Open in TSS</button>
          <button class="btn-danger-text js-remove" data-id="${escapeHtml(cls.id)}" title="Remove">&times;</button>
        </div>
      </div>
      <div class="planned-card-body">
        <div class="planned-schedule">${scheduleTags}</div>
        <div class="planned-info">
          <span class="planned-info-label">Open seats:</span>
          <span class="${seatsCls}">${escapeHtml(cls.seatsAvailable)}/${escapeHtml(cls.seatsTotal)}</span>
        </div>
        <div class="planned-info">
          <span class="planned-info-label">Total waitlist:</span>
          <span>${escapeHtml(cls.waitlistTotal ?? '—')}</span>
        </div>
        <div class="planned-info">
          <span class="planned-info-label">Instructor:</span>
          <span>${escapeHtml(cls.instructor)}</span>
        </div>
        <div class="planned-info">
          <span class="planned-info-label">Credits:</span>
          <span>${escapeHtml(cls.credits)}</span>
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
  list.querySelectorAll('.js-details').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      const cls = planned.find((c) => c.id === e.currentTarget.dataset.id);
      if (cls) openClassDetails(cls);
    });
  });
}

function renderAll() {
  renderCalendar();
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

function durationTime(value) {
  const match = String(value || '').match(/^PT(?:(\d+)H)?(?:(\d+)M)?/);
  if (!match) return value || '';
  const hours = Number(match[1] || 0);
  const minutes = Number(match[2] || 0);
  const suffix = hours >= 12 ? 'PM' : 'AM';
  const hour12 = hours % 12 || 12;
  return `${hour12}:${String(minutes).padStart(2, '0')} ${suffix}`;
}

function normalizeBooking(events) {
  return (events || []).map((event) => ({
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
      day: schedule.DayName || '',
      start: durationTime(schedule.StartTime),
      end: durationTime(schedule.EndTime),
      kind: schedule.MeetingTypeText || '',
      location: [event.RoomShort || event.RoomStext, schedule.ScheduleAdditionalInfo].filter(Boolean).join(' · '),
    })),
  }));
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

function bookingDetailHtml(cls) {
  const info = cls.bookingDetails;
  if (!info?.events?.length) return '<p class="muted">No booking details have been fetched yet.</p>';
  return info.events.map((event) => `
    <section class="detail-event">
      <h3>${escapeHtml(event.method)}</h3>
      <div class="detail-grid">
        <span>Booked</span><strong>${event.booked ? 'Yes' : 'No'}</strong>
        <span>Your waitlist position</span><strong>${escapeHtml(event.waitlistPosition)}</strong>
        <span>Waitlist booking</span><strong>${event.waitlistBooking ? 'Yes' : 'No'}</strong>
        <span>Registration state</span><strong>${escapeHtml(event.registrationState)}</strong>
        <span>Room</span><strong>${escapeHtml(event.room || '—')}</strong>
        <span>Registration window</span><strong>${escapeHtml(event.registrationBegin)} – ${escapeHtml(event.registrationEnd)}</strong>
      </div>
      <div class="detail-meetings">${event.events.map((meeting) => `
        <div>${escapeHtml(meeting.day)} ${escapeHtml(meeting.date)} · ${escapeHtml(meeting.start)}–${escapeHtml(meeting.end)} ${escapeHtml(meeting.kind)} ${escapeHtml(meeting.location)}</div>
      `).join('')}</div>
    </section>`).join('');
}

async function fetchAndStoreClassDetails(classId) {
  const cls = planned.find((item) => item.id === classId);
  if (!cls) return { error: 'missing-class' };
  const term = termForClass(cls);
  const sectionPromise = chrome.runtime.sendMessage({ type: 'getSections', moduleID: cls.moduleID, term });
  const bookingPromise = chrome.runtime.sendMessage({
    type: 'getBookingDetails', moduleID: cls.moduleID, eventPkgObjid: cls.eventPkgObjid, term,
  });
  const [sectionResult, bookingResult] = await Promise.allSettled([sectionPromise, bookingPromise]);
  let sectionError = null;
  let bookingError = null;
  let sectionPackages = [];
  const now = Date.now();
  await updateStoredClass(classId, (stored) => {
    const next = { ...stored };
    if (sectionResult.status === 'fulfilled' && sectionResult.value && !sectionResult.value.error) {
      sectionPackages = groupSections(sectionResult.value.sections || []);
      const pkg = sectionPackages.find((item) => item.otjid === stored.selectedPackageOtjid);
      next.sectionFetchedAt = now;
      next.sectionError = null;
      next.unavailable = !pkg;
      if (pkg) Object.assign(next, {
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
    } else {
      sectionError = sectionResult.status === 'rejected' ? sectionResult.reason?.message : sectionResult.value?.error;
      next.sectionError = String(sectionError || 'Section refresh failed');
    }
    if (bookingResult.status === 'fulfilled' && !bookingResult.value?.error) {
      next.bookingFetchedAt = now;
      next.bookingError = null;
      next.bookingDetails = { events: normalizeBooking(bookingResult.value.events), fetchedAt: now };
    } else {
      bookingError = bookingResult.status === 'rejected' ? bookingResult.reason?.message : bookingResult.value?.error;
      next.bookingError = String(bookingError || 'Booking refresh failed');
    }
    return next;
  });
  return { sectionError, bookingError, sectionPackages };
}

async function openClassDetails(cls) {
  if (selectedDetailId || detailRequests.has(cls.id)) return;
  selectedDetailId = cls.id;
  detailRequests.add(cls.id);
  const backdrop = document.createElement('div');
  backdrop.className = 'modal-backdrop';
  backdrop.innerHTML = `<div class="modal details-modal">
    <div class="modal-head"><div class="modal-title">${escapeHtml(cls.courseAbbr)} · ${escapeHtml(cls.courseTitle)}</div><button class="modal-close" aria-label="Close">×</button></div>
    <div class="modal-body detail-body"><p class="req-loading">Fetching current class and booking details…</p></div>
    <div class="modal-foot"><button class="btn btn-primary js-detail-close">Close</button></div>
  </div>`;
  document.body.appendChild(backdrop);
  const close = () => { selectedDetailId = null; backdrop.remove(); };
  backdrop.querySelector('.modal-close').addEventListener('click', close);
  backdrop.querySelector('.js-detail-close').addEventListener('click', close);
  backdrop.addEventListener('click', (event) => { if (event.target === backdrop) close(); });
  const errors = await fetchAndStoreClassDetails(cls.id);
  detailRequests.delete(cls.id);
  if (!backdrop.isConnected) return;
  if (['no-auth', 'auth-expired'].includes(errors.sectionError) || ['no-auth', 'auth-expired'].includes(errors.bookingError)) showAuthBanner('expired');
  const current = planned.find((item) => item.id === cls.id) || cls;
  const body = backdrop.querySelector('.detail-body');
  const schedule = (current.scheduleBlocks || []).map((block) => block.isFinal
    ? `<div>${escapeHtml(finalDateLabel(block))} · ${escapeHtml(finalTimeLabel(block))} · ${escapeHtml(block.location)}</div>`
    : `<div>${escapeHtml(block.day)} · ${escapeHtml(block.start)}–${escapeHtml(block.end)} · ${escapeHtml(block.location)}</div>`).join('');
  body.innerHTML = `<section class="detail-event"><h3>Selected section ${escapeHtml(current.selectedPackageOtjid)}</h3>
    <div class="detail-grid"><span>Open seats / capacity</span><strong>${escapeHtml(current.seatsAvailable)}/${escapeHtml(current.seatsTotal)}</strong>
    <span>Total waitlist</span><strong>${escapeHtml(current.waitlistTotal ?? '—')}</strong>
    <span>Instructor</span><strong>${escapeHtml(current.instructor)}</strong><span>Status</span><strong>${escapeHtml(current.status || '—')}</strong>
    <span>Last section check</span><strong>${escapeHtml(formatTimestamp(current.sectionFetchedAt))}</strong></div>
    <div class="detail-meetings">${schedule || 'No schedule information available.'}</div>
    ${current.unavailable ? '<p class="req-error">This package is no longer listed. Your saved details are retained.</p>' : ''}
    ${current.unavailable && errors.sectionPackages.length ? '<button class="btn js-replace-section">Choose a different section</button>' : ''}
    ${errors.sectionError ? `<p class="req-error">Section request failed: ${escapeHtml(errors.sectionError)}</p>` : ''}</section>
    ${bookingDetailHtml(current)}
    <p class="detail-updated">Booking checked ${escapeHtml(formatTimestamp(current.bookingFetchedAt))}${errors.bookingError ? ` · Request failed: ${escapeHtml(errors.bookingError)}` : ''}</p>`;
  const replaceButton = body.querySelector('.js-replace-section');
  if (replaceButton) replaceButton.addEventListener('click', () => {
    const term = termForClass(current);
    close();
    openSectionPicker(current, errors.sectionPackages, term, current.id);
  });
}

function formatTimestamp(value) {
  if (!value) return 'Never';
  return new Intl.DateTimeFormat('en-US', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value));
}

function refreshMetaLabel(run) {
  if (!run?.startedAt) return 'Class details have not been refreshed yet.';
  if (!run.finishedAt) return `Refresh started ${formatTimestamp(run.startedAt)} (${run.completed || 0}/${run.total} in progress)`;
  return `Last refresh: ${formatTimestamp(run.startedAt)} (${Math.max(0, run.total - run.errors)}/${run.total} complete)`;
}

function showRefreshStatus(message, error = false) {
  const status = document.getElementById('refresh-status');
  if (!status) return;
  status.textContent = message;
  status.classList.toggle('hidden', !message);
  status.classList.toggle('danger', error);
}

async function refreshAllClasses() {
  const { lastRefreshRun: previousRun } = await chrome.storage.local.get('lastRefreshRun');
  if (previousRun?.startedAt && !previousRun.finishedAt && Date.now() - previousRun.startedAt < 30 * 60 * 1000) {
    showRefreshStatus('A class refresh is already running in another planner tab.');
    return;
  }
  if (!planned.length) {
    showRefreshStatus('Add a class before refreshing class info.');
    return;
  }
  const button = document.getElementById('refresh-all');
  const classes = [...planned];
  const startedAt = Date.now();
  const run = { startedAt, finishedAt: null, total: classes.length, completed: 0, errors: 0 };
  await chrome.storage.local.set({ lastRefreshRun: run });
  if (button) button.disabled = true;
  const sectionCache = new Map();
  let authFailed = false;
  for (let index = 0; index < classes.length; index++) {
    const cls = classes[index];
    showRefreshStatus(`Refreshing ${index + 1} of ${classes.length}: ${cls.courseAbbr}…`);
    const term = termForClass(cls);
    const cacheKey = `${cls.moduleID}|${term.academicYear}|${term.academicPeriod}`;
    if (!sectionCache.has(cacheKey)) {
      try {
        sectionCache.set(cacheKey, await chrome.runtime.sendMessage({ type: 'getSections', moduleID: cls.moduleID, term }));
      } catch (error) {
        sectionCache.set(cacheKey, { error: error.message || 'network' });
      }
    }
    const sectionResult = sectionCache.get(cacheKey);
    const bookingResult = await chrome.runtime.sendMessage({
      type: 'getBookingDetails', moduleID: cls.moduleID, eventPkgObjid: cls.eventPkgObjid, term,
    }).catch((error) => ({ error: error.message || 'network' }));
    const now = Date.now();
    if (['no-auth', 'auth-expired'].includes(sectionResult?.error) || ['no-auth', 'auth-expired'].includes(bookingResult?.error)) authFailed = true;
    let failed = false;
    await updateStoredClass(cls.id, (stored) => {
      const next = { ...stored };
      if (sectionResult && !sectionResult.error) {
        const pkg = groupSections(sectionResult.sections || []).find((item) => item.otjid === stored.selectedPackageOtjid);
        next.sectionFetchedAt = now;
        next.sectionError = null;
        next.unavailable = !pkg;
        if (pkg) Object.assign(next, {
          eventPkgObjid: pkg.objid, seatsAvailable: pkg.seatsAvailable, seatsTotal: pkg.seatsTotal,
          waitlistTotal: pkg.waitlistTotal, instructor: pkg.instructor, status: pkg.status,
          location: pkg.location, scheduleBlocks: pkg.scheduleBlocks, _lastPkg: pkg,
        });
        else failed = true;
      } else {
        next.sectionError = sectionResult.error;
        failed = true;
      }
      if (!bookingResult?.error) {
        next.bookingFetchedAt = now;
        next.bookingError = null;
        next.bookingDetails = { events: normalizeBooking(bookingResult.events), fetchedAt: now };
      } else {
        next.bookingError = bookingResult.error;
        failed = true;
      }
      return next;
    });
    run.completed++;
    if (failed) run.errors++;
    await chrome.storage.local.set({ lastRefreshRun: { ...run } });
  }
  run.finishedAt = Date.now();
  await chrome.storage.local.set({ lastRefreshRun: run });
  if (button) button.disabled = false;
  if (authFailed) showAuthBanner('expired');
  showRefreshStatus(`Refresh complete: ${run.completed - run.errors}/${run.total} classes fully refreshed; ${run.errors} need attention.`);
}

// ---------- Auth banner ----------
function showAuthBanner(mode, extra) {
  const banner = document.getElementById('auth-banner');
  const text = document.getElementById('auth-text');
  banner.classList.remove('hidden', 'danger');
  if (mode === 'expired') {
    banner.classList.add('danger');
    text.textContent = 'Your TSS session has expired. Log into TSS again to fetch class info. Your planned classes are preserved.';
  } else if (mode === 'not-connected') {
    text.textContent = 'Not connected to TSS. Open TSS and log in to capture your session; your planned classes are kept.';
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
        .map((m) => `<span class="method-tag ${escapeHtml(m.toLowerCase())}">${escapeHtml(m)}</span>`)
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
async function checkAuth() {
  const status = await chrome.runtime.sendMessage({ type: 'getSessionStatus' });
  if (!status?.connected) {
    showAuthBanner('not-connected');
  } else {
    hideAuthBanner();
  }
  const capture = document.getElementById('capture-meta');
  if (capture) capture.textContent = `Last TSS session capture: ${formatTimestamp(status?.capturedAt)}`;
}

document.addEventListener('DOMContentLoaded', async () => {
  isPlanner = document.body.classList.contains('full-planner');
  planned = await loadPlanned();
  await loadTerm();
  document.getElementById('term-badge').textContent = termBadge(currentTerm);
  const { settings, lastRefreshRun } = await chrome.storage.local.get(['settings', 'lastRefreshRun']);
  showFinals = Boolean(settings?.showFinals);
  document.getElementById('show-finals').checked = showFinals;
  renderAll();
  checkAuth();

  const refreshMeta = document.getElementById('refresh-meta');
  if (refreshMeta) refreshMeta.textContent = refreshMetaLabel(lastRefreshRun);

  const plannerButton = document.getElementById('open-planner');
  if (plannerButton) plannerButton.addEventListener('click', () => chrome.tabs.create({ url: chrome.runtime.getURL('planner.html') }));
  const refreshButton = document.getElementById('refresh-all');
  if (refreshButton) refreshButton.addEventListener('click', () => {
    if (isPlanner) refreshAllClasses();
    else chrome.tabs.create({ url: `${chrome.runtime.getURL('planner.html')}?refresh=all` });
  });

  const input = document.getElementById('search-input');
  const searchBtn = document.getElementById('search-btn');
  searchBtn.addEventListener('click', doSearch);
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') doSearch(); });

  const showFinalsEl = document.getElementById('show-finals');
  showFinalsEl.addEventListener('change', async () => {
    showFinals = showFinalsEl.checked;
    const latest = await chrome.storage.local.get('settings');
    await chrome.storage.local.set({ settings: { ...(latest.settings || {}), showFinals } });
    renderAll();
  });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    if (changes.plannedClasses) {
      planned = Array.isArray(changes.plannedClasses.newValue) ? changes.plannedClasses.newValue : [];
      renderAll();
    }
    if (changes.settings) {
      showFinals = Boolean(changes.settings.newValue?.showFinals);
      showFinalsEl.checked = showFinals;
      renderAll();
    }
    if (changes.lastRefreshRun) {
      const run = changes.lastRefreshRun.newValue;
      if (refreshMeta && run) refreshMeta.textContent = refreshMetaLabel(run);
    }
    if (changes.auth) checkAuth();
  });

  if (isPlanner && new URLSearchParams(location.search).get('refresh') === 'all') {
    history.replaceState(null, '', location.pathname);
    refreshAllClasses();
  }
});
