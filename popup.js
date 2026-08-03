const START_HOUR = 8;
const END_HOUR = 20;
const HOUR_HEIGHT = 60;
const DAYS = ['M', 'Tu', 'W', 'Th', 'F'];
const DAY_LABELS = { M: 'Mon', Tu: 'Tue', W: 'Wed', Th: 'Thu', F: 'Fri' };

const SAMPLE_PLANNED = [
  {
    id: 'p1',
    moduleID: '14487',
    courseAbbr: 'PHYS-002C',
    courseTitle: 'Physics - Fluids, Waves, Thermodynamics, and Optics',
    credits: '4.00',
    instructor: 'Tan, Tzer Han',
    seatsAvailable: 21,
    seatsTotal: 30,
    scheduleBlocks: [
      { day: 'M', start: '09:00', end: '09:50', location: 'Galbraith Hall 242', type: 'LE' },
      { day: 'W', start: '09:00', end: '09:50', location: 'Galbraith Hall 242', type: 'LE' },
      { day: 'F', start: '09:00', end: '09:50', location: 'Galbraith Hall 242', type: 'LE' },
      { day: 'Tu', start: '08:00', end: '08:50', location: 'Galbraith Hall 242', type: 'DI' }
    ]
  },
  {
    id: 'p2',
    moduleID: '91001',
    courseAbbr: 'CSE-012',
    courseTitle: 'Programming and Problem Solving',
    credits: '4.00',
    instructor: 'Cao, Yingzi',
    seatsAvailable: 5,
    seatsTotal: 60,
    scheduleBlocks: [
      { day: 'Tu', start: '09:30', end: '10:45', location: 'Solis Hall 110', type: 'LE' },
      { day: 'Th', start: '09:30', end: '10:45', location: 'Solis Hall 110', type: 'LE' }
    ]
  }
];

let planned = JSON.parse(JSON.stringify(SAMPLE_PLANNED));

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

function detectConflicts(classes) {
  const conflictIds = new Set();
  const allBlocks = [];
  for (const cls of classes) {
    for (const b of cls.scheduleBlocks) {
      allBlocks.push({ ...b, classId: cls.id, courseAbbr: cls.courseAbbr });
    }
  }
  for (let i = 0; i < allBlocks.length; i++) {
    for (let j = i + 1; j < allBlocks.length; j++) {
      const a = allBlocks[i], b = allBlocks[j];
      if (a.day !== b.day) continue;
      const aS = timeToMinutes(a.start), aE = timeToMinutes(a.end);
      const bS = timeToMinutes(b.start), bE = timeToMinutes(b.end);
      if (aS < bE && aE > bS) {
        conflictIds.add(a.classId);
        conflictIds.add(b.classId);
      }
    }
  }
  return conflictIds;
}

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
  const conflictIds = detectConflicts(planned);
  for (const cls of planned) {
    const isConflict = conflictIds.has(cls.id);
    for (const b of cls.scheduleBlocks) {
      const col = document.querySelector(`.day-col[data-day="${b.day}"] .day-body`);
      if (!col) continue;
      const startMin = timeToMinutes(b.start) - START_HOUR * 60;
      const endMin = timeToMinutes(b.end) - START_HOUR * 60;
      const top = (startMin / 60) * HOUR_HEIGHT;
      const height = Math.max(((endMin - startMin) / 60) * HOUR_HEIGHT, 18);
      const block = document.createElement('div');
      block.className = `block ${b.type.toLowerCase()}${isConflict ? ' conflict' : ''}`;
      block.style.top = `${top}px`;
      block.style.height = `${height}px`;
      block.title = `${cls.courseAbbr} ${b.type}\n${minutesToLabel(timeToMinutes(b.start))} - ${minutesToLabel(timeToMinutes(b.end))}\n${b.location}${isConflict ? '\n⚠ Conflict' : ''}`;
      block.innerHTML = `<div class="block-title">${cls.courseAbbr}</div><div class="block-time">${b.start}-${b.end}</div><div class="block-loc">${b.location}</div>`;
      col.appendChild(block);
    }
  }
}

function seatsClass(avail, total) {
  if (avail <= 0) return 'seats-full';
  if (avail <= total * 0.15) return 'seats-low';
  return 'seats-ok';
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
  const conflictIds = detectConflicts(planned);
  for (const cls of planned) {
    const isConflict = conflictIds.has(cls.id);
    const card = document.createElement('div');
    card.className = `planned-card${isConflict ? ' conflict-card' : ''}`;

    const scheduleTags = cls.scheduleBlocks.map(b =>
      `<span class="schedule-tag ${b.type.toLowerCase()}">${b.day} ${b.start}-${b.end}</span>`
    ).join('');

    const seatsCls = seatsClass(cls.seatsAvailable, cls.seatsTotal);

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
        ${isConflict ? '<div class="conflict-note">⚠ Scheduling conflict detected</div>' : ''}
      </div>
    `;
    list.appendChild(card);
  }
  list.querySelectorAll('.js-remove').forEach(btn => {
    btn.addEventListener('click', e => {
      const id = e.currentTarget.dataset.id;
      planned = planned.filter(c => c.id !== id);
      renderAll();
    });
  });
  list.querySelectorAll('.js-open').forEach(btn => {
    btn.addEventListener('click', e => {
      const id = e.currentTarget.dataset.id;
      const cls = planned.find(c => c.id === id);
      if (cls) openSectionPicker(cls);
    });
  });
}

function renderAll() {
  renderCalendar();
  renderPlannedList();
}

function showSearchResults(show) {
  const el = document.getElementById('search-results');
  if (show) el.classList.remove('hidden');
  else el.classList.add('hidden');
}

function openSectionPicker(cls) {
  const backdrop = document.createElement('div');
  backdrop.className = 'modal-backdrop';
  backdrop.innerHTML = `
    <div class="modal">
      <div class="modal-head">
        <div class="modal-title">${cls.courseAbbr} — Choose a Section</div>
        <button class="modal-close">&times;</button>
      </div>
      <div class="modal-body">
        <div class="package-option">
          <div class="package-head">
            <span class="package-id">Section A — #SE00156451</span>
            <div class="package-methods"><span class="method-tag le">LE</span><span class="method-tag di">DI</span></div>
          </div>
          <div class="package-detail">
            <span>LE: M/W/F 9:00-9:50 AM — Galbraith Hall 242</span>
            <span>DI: Tu 8:00-8:50 AM — Galbraith Hall 242</span>
            <span>Seats: 21/30 · Tan, Tzer Han</span>
          </div>
        </div>
        <div class="package-option">
          <div class="package-head">
            <span class="package-id">Section B — #SE00156452</span>
            <div class="package-methods"><span class="method-tag le">LE</span><span class="method-tag di">DI</span></div>
          </div>
          <div class="package-detail">
            <span>LE: M/W/F 10:00-10:50 AM — Galbraith Hall 242</span>
            <span>DI: Th 8:00-8:50 AM — Galbraith Hall 242</span>
            <span>Seats: 0/30 · Staff</span>
          </div>
        </div>
        <div class="package-option">
          <div class="package-head">
            <span class="package-id">Section C — #SE00156453</span>
            <div class="package-methods"><span class="method-tag le">LE</span></div>
          </div>
          <div class="package-detail">
            <span>LE: Tu/Th 11:00-12:15 PM — Center Hall 212</span>
            <span>Seats: 14/40 · Cao, Yingzi</span>
          </div>
        </div>
      </div>
      <div class="modal-foot">
        <button class="btn js-modal-cancel">Cancel</button>
        <button class="btn btn-primary js-modal-add">Add to Plan</button>
      </div>
    </div>
  `;
  document.body.appendChild(backdrop);
  let selected = null;
  backdrop.querySelectorAll('.package-option').forEach(opt => {
    opt.addEventListener('click', () => {
      backdrop.querySelectorAll('.package-option').forEach(o => o.classList.remove('selected'));
      opt.classList.add('selected');
      selected = opt;
    });
  });
  const close = () => backdrop.remove();
  backdrop.querySelector('.modal-close').addEventListener('click', close);
  backdrop.querySelector('.js-modal-cancel').addEventListener('click', close);
  backdrop.addEventListener('click', e => { if (e.target === backdrop) close(); });
  backdrop.querySelector('.js-modal-add').addEventListener('click', () => {
    if (!selected) {
      alert('Please select a section package.');
      return;
    }
    close();
  });
}

document.addEventListener('DOMContentLoaded', () => {
  buildTimeAxis();
  renderAll();

  const input = document.getElementById('search-input');
  const searchBtn = document.getElementById('search-btn');
  const doSearch = () => {
    const q = input.value.trim();
    showSearchResults(q.length > 0);
  };
  searchBtn.addEventListener('click', doSearch);
  input.addEventListener('keydown', e => { if (e.key === 'Enter') doSearch(); });

  document.querySelectorAll('.result-item').forEach(item => {
    item.addEventListener('click', () => {
      const abbr = item.querySelector('.result-abbr').textContent;
      openSectionPicker({ courseAbbr: abbr, courseTitle: item.querySelector('.result-title').textContent });
    });
  });

  document.getElementById('auth-dismiss').addEventListener('click', () => {
    document.getElementById('auth-banner').classList.add('hidden');
  });
});
