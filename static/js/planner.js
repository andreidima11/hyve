/**
 * Planner — dedicated module.
 *   To-Do  : lists + checkable tasks
 *   Events : Google-Calendar-style month / week / day views (all events, no lists)
 */
import { apiCall } from './api.js';
import { escapeHtml, showToast, showConfirm } from './utils.js';

// ── State ──────────────────────────────────────────────────────────────
let listsCache = [];
let entriesCache = [];          // tasks for the selected list
let eventsCache = [];           // ALL events (cross-list)
let selectedListId = null;
let activeTab = 'tasks';        // 'tasks' | 'events'
let filterStatus = 'open';      // 'open' | 'done' | 'all'
let calView = 'month';          // 'month' | 'week' | 'day'
let calDate = new Date();       // reference date for calendar navigation
let dragEntryId = null;
let dragEventId = null;

// Persist calendar view selection across visits
try {
    const _sv = localStorage.getItem('plannerCalView');
    if (_sv && ['month', 'week', 'day'].includes(_sv)) calView = _sv;
} catch {}

// ── Helpers ────────────────────────────────────────────────────────────
function selectedList() {
    return listsCache.find(l => l.id === selectedListId) || null;
}

function todayDate() { const n = new Date(); return new Date(n.getFullYear(), n.getMonth(), n.getDate()); }
function sameDay(a, b) { return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate(); }
function isToday(d) { return sameDay(d, new Date()); }
function dateKey(d) { return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`; }

function weekDaysFor(refDate) {
    const d = new Date(refDate);
    const day = d.getDay();
    const delta = day === 0 ? -6 : 1 - day;
    const mon = new Date(d);
    mon.setDate(d.getDate() + delta);
    mon.setHours(0,0,0,0);
    return Array.from({ length: 7 }, (_, i) => { const x = new Date(mon); x.setDate(mon.getDate() + i); return x; });
}

function monthGrid(refDate) {
    const y = refDate.getFullYear(), m = refDate.getMonth();
    const first = new Date(y, m, 1);
    const startDay = (first.getDay() + 6) % 7; // Mon=0
    const start = new Date(first);
    start.setDate(1 - startDay);
    const cells = [];
    for (let i = 0; i < 42; i++) { const d = new Date(start); d.setDate(start.getDate() + i); cells.push(d); }
    return cells;
}

function shortDay(d) { return d.toLocaleDateString(undefined, { weekday: 'short' }); }
function shortDayNarrow(d) { return d.toLocaleDateString(undefined, { weekday: 'narrow' }); }

function formatTime(isoStr) {
    if (!isoStr) return '';
    const d = new Date(isoStr);
    if (isNaN(d.getTime())) return '';
    return d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
}

function formatDate(isoStr) {
    if (!isoStr) return '';
    const d = new Date(isoStr);
    if (isNaN(d.getTime())) return '';
    return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

function localISOString(d) {
    const pad = n => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function addMinutes(dt, minutes) {
    return new Date(dt.getTime() + (minutes * 60000));
}

function eventDurationMs(ev) {
    const s = ev?.start_at ? new Date(ev.start_at) : null;
    const e = ev?.end_at ? new Date(ev.end_at) : null;
    if (s && e && !isNaN(s.getTime()) && !isNaN(e.getTime()) && e > s) {
        return e.getTime() - s.getTime();
    }
    return 60 * 60 * 1000;
}

function entryWhen(e) {
    return e.entry_type === 'event' ? (e.start_at || e.end_at) : e.due_at;
}

function sortEntries(list) {
    return [...list].sort((a, b) => {
        if ((a.position ?? 0) !== (b.position ?? 0)) return (a.position ?? 0) - (b.position ?? 0);
        const ta = Date.parse(a.updated_at || a.created_at || 0) || 0;
        const tb = Date.parse(b.updated_at || b.created_at || 0) || 0;
        return tb - ta;
    });
}

function priorityColor(p) {
    if (p === 1) return '#ef4444';
    if (p === 2) return '#f97316';
    if (p === 3) return '#eab308';
    if (p === 4) return '#38bdf8';
    return '#64748b';
}

// ── API helpers ────────────────────────────────────────────────────────
async function fetchLists() {
    const res = await apiCall('/api/lists?include_archived=false');
    const data = await res.json();
    return data.lists || [];
}

async function fetchEntries(listId) {
    const res = await apiCall(`/api/entries?list_id=${listId}&entry_type=task&include_archived=false&limit=500`);
    const data = await res.json();
    return data.entries || [];
}

async function fetchAllEvents() {
    const res = await apiCall('/api/entries?entry_type=event&include_archived=false&limit=500');
    const data = await res.json();
    return data.entries || [];
}


// ── Render: Lists drawer (To-Do only) ─────────────────────────────────
function renderLists() {
    const wrap = document.getElementById('planner-lists-drawer-body');
    if (!wrap) return;
    if (!listsCache.length) { wrap.innerHTML = '<div class="p-empty">No lists yet</div>'; return; }
    wrap.innerHTML = listsCache.map(list => {
        const active = selectedListId === list.id ? 'p-list-item--active' : '';
        return `<button class="p-list-item ${active}" onclick="plannerSelectList(${list.id}); plannerCloseDrawer()">
            <span class="p-list-item-title">${escapeHtml(list.title)}</span>
            <button class="p-list-delete" onclick="event.stopPropagation(); plannerDeleteList(${list.id})" title="Delete list"><i class="fas fa-trash-can"></i></button>
        </button>`;
    }).join('');
}

// ── Render: To-Do entry list ───────────────────────────────────────────
function renderTodoEntries() {
    const wrap = document.getElementById('planner-entries');
    if (!wrap) return;
    if (!selectedListId) { wrap.innerHTML = '<div class="p-empty">Select a list to begin</div>'; return; }

    let items = sortEntries(entriesCache);
    if (filterStatus === 'open') items = items.filter(e => e.task_status !== 'done');
    else if (filterStatus === 'done') items = items.filter(e => e.task_status === 'done');

    if (!items.length) { wrap.innerHTML = `<div class="p-empty">${filterStatus === 'done' ? 'No completed tasks' : 'All clear! Add something.'}</div>`; return; }

    const canDrag = filterStatus !== 'done';
    wrap.innerHTML = items.map(entry => {
        const done = entry.task_status === 'done';
        const dateStr = entry.due_at ? formatDate(entry.due_at) : '';
        const prio = entry.priority;
        return `<div class="p-entry ${done ? 'p-entry--done' : ''}" draggable="${canDrag}"
                    ondragstart="plannerDragStart(event, ${entry.id})" ondragover="plannerDragOver(event)"
                    ondrop="plannerDrop(event, ${entry.id})" ondragend="plannerDragEnd(event)">
            <button class="p-entry-check" onclick="plannerToggleDone(${entry.id})" title="${done ? 'Reopen' : 'Complete'}">
                ${done ? '<i class="fas fa-check-circle"></i>' : '<i class="far fa-circle"></i>'}
            </button>
            <div class="p-entry-body" onclick="plannerEntryActions(${entry.id})">
                <span class="p-entry-title ${done ? 'p-entry-title--done' : ''}">${escapeHtml(entry.title)}</span>
                ${dateStr ? `<span class="p-entry-meta">${dateStr}</span>` : ''}
            </div>
            ${prio ? `<span class="p-entry-prio" style="background:${priorityColor(prio)}" title="Priority ${prio}"></span>` : ''}
        </div>`;
    }).join('');
}

// ══════════════════════════════════════════════════════════════════════
// ── Events: Calendar views (month / week / day) ──────────────────────
// ══════════════════════════════════════════════════════════════════════

function eventsForDate(d) {
    const k = dateKey(d);
    return eventsCache.filter(ev => (ev.start_at || ev.due_at || '').slice(0, 10) === k);
}

function renderEventsPanel() {
    const wrap = document.getElementById('planner-events-panel');
    if (!wrap) return;
    const header = renderCalHeader();
    const viewSelector = renderCalViewSelector();
    let body = '';
    if (calView === 'month') body = renderMonthView();
    else if (calView === 'week') body = renderWeekView();
    else body = renderDayView();
    wrap.innerHTML = header + viewSelector + body;
}

function renderCalHeader() {
    let title = '';
    if (calView === 'month') {
        title = calDate.toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
    } else if (calView === 'week') {
        const days = weekDaysFor(calDate);
        const s = days[0], e = days[6];
        title = s.getMonth() === e.getMonth()
            ? `${s.getDate()} – ${e.getDate()} ${s.toLocaleDateString(undefined, { month: 'long', year: 'numeric' })}`
            : `${s.toLocaleDateString(undefined, { day: 'numeric', month: 'short' })} – ${e.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' })}`;
    } else {
        title = calDate.toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
    }
    return `<div class="p-cal-header">
        <button class="p-cal-nav" onclick="plannerCalPrev()"><i class="fas fa-chevron-left"></i></button>
        <button class="p-cal-title" onclick="plannerCalToday()">${title}</button>
        <button class="p-cal-nav" onclick="plannerCalNext()"><i class="fas fa-chevron-right"></i></button>
    </div>`;
}

function renderCalViewSelector() {
    const views = [['month','Month'],['week','Week'],['day','Day']];
    return `<div class="p-cal-views">${views.map(([v, label]) =>
        `<button class="p-cal-view-btn ${calView === v ? 'p-cal-view-btn--active' : ''}" onclick="plannerSetCalView('${v}')">${label}</button>`
    ).join('')}</div>`;
}

function renderMonthView() {
    const cells = monthGrid(calDate);
    const curMonth = calDate.getMonth();
    const dayHeaders = ['Mon','Tue','Wed','Thu','Fri','Sat','Sun'];

    let html = '<div class="p-month-grid">';
    html += dayHeaders.map(d => `<div class="p-month-hdr">${d}</div>`).join('');
    cells.forEach(d => {
        const today = isToday(d);
        const other = d.getMonth() !== curMonth;
        const dayEvts = eventsForDate(d);
        const dk = dateKey(d);
        html += `<div class="p-month-cell ${today ? 'p-month-cell--today' : ''} ${other ? 'p-month-cell--other' : ''}" onclick="plannerCalClickDay('${dk}')" ondragover="plannerEventDragOver(event)" ondrop="plannerEventDropDay(event, '${dk}')">
            <span class="p-month-num ${today ? 'p-month-num--today' : ''}">${d.getDate()}</span>
            <div class="p-month-events">${dayEvts.slice(0, 3).map(ev =>
                `<div class="p-month-evt" draggable="true" ondragstart="plannerEventDragStart(event, ${ev.id})" ondragend="plannerEventDragEnd(event)" onclick="event.stopPropagation(); plannerEntryActions(${ev.id})" style="border-left-color:${escapeHtml(ev.event_color || '#4f46e5')}">${formatTime(ev.start_at) ? `<span class="p-month-evt-time">${formatTime(ev.start_at)}</span> ` : ''}${escapeHtml(ev.title)}</div>`
            ).join('')}${dayEvts.length > 3 ? `<div class="p-month-more">+${dayEvts.length - 3} more</div>` : ''}</div>
        </div>`;
    });
    html += '</div>';
    return html;
}

function renderWeekView() {
    const days = weekDaysFor(calDate);
    const now = new Date();
    const nowHour = now.getHours();
    const nowMinute = now.getMinutes();
    let html = '<div class="p-week-grid">';
    // header row
    html += '<div class="p-week-hdr-row"><div class="p-week-time-col"></div>';
    days.forEach(d => {
        const today = isToday(d);
        html += `<div class="p-week-hdr ${today ? 'p-week-hdr--today' : ''}">${shortDay(d)} <span class="p-week-hdr-num ${today ? 'p-week-hdr-num--today' : ''}">${d.getDate()}</span></div>`;
    });
    html += '</div>';
    // hour rows (6:00 - 23:00)
    for (let h = 6; h < 24; h++) {
        const label = `${String(h).padStart(2,'0')}:00`;
        html += `<div class="p-week-row">`;
        html += `<div class="p-week-time-col">${label}</div>`;
        days.forEach(d => {
            const dk = dateKey(d);
            const isNowCell = isToday(d) && h === nowHour;
            const nowLineTop = isNowCell ? `${(nowMinute / 60 * 2.5).toFixed(2)}rem` : null;
            const hourEvts = eventsCache.filter(ev => {
                if (!ev.start_at) return false;
                const s = new Date(ev.start_at);
                return dateKey(s) === dk && s.getHours() === h;
            });
            html += `<div class="p-week-cell${isNowCell ? ' p-week-cell--now' : ''}" onclick="plannerCalClickHour('${dk}', ${h})" ondragover="plannerEventDragOver(event)" ondrop="plannerEventDropHour(event, '${dk}', ${h})">
                ${nowLineTop ? `<div class="p-now-line" style="top:${nowLineTop}"></div>` : ''}
                ${hourEvts.map(ev => `<div class="p-week-evt" draggable="true" ondragstart="plannerEventDragStart(event, ${ev.id})" ondragend="plannerEventDragEnd(event)" onclick="event.stopPropagation(); plannerEntryActions(${ev.id})" style="background:${escapeHtml(ev.event_color || '#4f46e5')}">${escapeHtml(ev.title)}</div>`).join('')}
            </div>`;
        });
        html += '</div>';
    }
    html += '</div>';
    return html;
}

function renderDayView() {
    const dk = dateKey(calDate);
    const now = new Date();
    const nowHour = now.getHours();
    const nowMinute = now.getMinutes();
    let html = '<div class="p-day-grid">';
    for (let h = 0; h < 24; h++) {
        const label = `${String(h).padStart(2,'0')}:00`;
        const isNowRow = isToday(calDate) && h === nowHour;
        const nowLineTop = isNowRow ? `${(nowMinute / 60 * 3.2).toFixed(2)}rem` : null;
        const hourEvts = eventsCache.filter(ev => {
            if (!ev.start_at) return false;
            const s = new Date(ev.start_at);
            return dateKey(s) === dk && s.getHours() === h;
        });
        html += `<div class="p-day-row${isNowRow ? ' p-day-row--now' : ''}" onclick="plannerCalClickHour('${dk}', ${h})" ondragover="plannerEventDragOver(event)" ondrop="plannerEventDropHour(event, '${dk}', ${h})">
            <div class="p-day-time">${label}</div>
            <div class="p-day-content">
                ${hourEvts.map(ev => `<div class="p-day-evt" draggable="true" ondragstart="plannerEventDragStart(event, ${ev.id})" ondragend="plannerEventDragEnd(event)" onclick="event.stopPropagation(); plannerEntryActions(${ev.id})" style="border-left-color:${escapeHtml(ev.event_color || '#4f46e5')}">
                    <span class="p-day-evt-time">${formatTime(ev.start_at)}${ev.end_at ? ' – ' + formatTime(ev.end_at) : ''}</span>
                    <span class="p-day-evt-title">${escapeHtml(ev.title)}</span>
                    ${ev.location ? `<span class="p-day-evt-loc"><i class="fas fa-map-pin"></i> ${escapeHtml(ev.location)}</span>` : ''}
                </div>`).join('')}
            </div>
            ${nowLineTop ? `<div class="p-now-line" style="top:${nowLineTop}"></div>` : ''}
        </div>`;
    }
    html += '</div>';
    return html;
}

// ── Master render / panel switching ────────────────────────────────────
function renderActivePanel() {
    const todoPanel = document.getElementById('planner-todo-panel');
    const eventsPanel = document.getElementById('planner-events-panel');
    if (!todoPanel || !eventsPanel) return;

    // Show/hide drawer burger based on tab (mobile)
    const burger = document.querySelector('.p-header-menu');
    if (burger) burger.style.display = activeTab === 'tasks' ? '' : 'none';

    // Toggle sidebar visibility — only show on To-Do tab
    const shell = document.querySelector('.planner-shell');
    if (shell) shell.classList.toggle('planner-shell--no-sidebar', activeTab !== 'tasks');

    todoPanel.style.display = activeTab === 'tasks' ? '' : 'none';
    eventsPanel.style.display = activeTab === 'events' ? 'flex' : 'none';

    if (activeTab === 'tasks') renderTodoEntries();
    else if (activeTab === 'events') renderEventsPanel();
}

// ── Load data ──────────────────────────────────────────────────────────
async function loadTodoEntries() {
    if (!selectedListId) { entriesCache = []; return; }
    try { entriesCache = await fetchEntries(selectedListId); } catch { entriesCache = []; }
}

async function loadEvents() {
    try { eventsCache = await fetchAllEvents(); } catch { eventsCache = []; }
}

// ── Public API (exported, bound to window in app.js) ───────────────────

export async function loadPlanner() {
    try {
        listsCache = await fetchLists();
        if (!listsCache.length) {
            const res = await apiCall('/api/lists', { method: 'POST', body: { title: 'Inbox', color: 'sky', icon: 'inbox' } });
            if (res.ok) listsCache = await fetchLists();
        }
        if (!listsCache.some(l => l.id === selectedListId)) {
            selectedListId = listsCache[0]?.id || null;
        }
        renderLists();
        updateHeader();
        await Promise.all([loadTodoEntries(), loadEvents()]);
        renderActivePanel();
    } catch (e) {
        const wrap = document.getElementById('planner-entries');
        if (wrap) wrap.innerHTML = `<div class="p-empty">Error: ${escapeHtml(String(e.message || e))}</div>`;
    }
}

function updateHeader() {
    const title = document.getElementById('planner-header-title');
    if (!title) return;
    if (activeTab === 'tasks') title.textContent = selectedList()?.title || 'Planner';
    else title.textContent = 'Events';
}

export async function plannerCreateList() {
    const input = document.getElementById('planner-new-list-input');
    const title = input?.value?.trim();
    if (!title) return;
    const res = await apiCall('/api/lists', { method: 'POST', body: { title } });
    if (!res.ok) { showToast('Could not create list', 'error'); return; }
    if (input) input.value = '';
    await loadPlanner();
}

export async function plannerDeleteList(listId) {
    if (!(await showConfirm('Delete this list and all its entries?'))) return;
    const res = await apiCall(`/api/lists/${listId}?hard_delete=true`, { method: 'DELETE' });
    if (res.ok) {
        if (selectedListId === listId) selectedListId = null;
        await loadPlanner();
        showToast('List deleted', 'success');
    } else {
        showToast('Could not delete list', 'error');
    }
}

export async function plannerSelectList(listId) {
    selectedListId = Number(listId);
    renderLists();
    updateHeader();
    await loadTodoEntries();
    renderActivePanel();
}

export function plannerOpenDrawer() {
    document.getElementById('planner-lists-drawer')?.classList.add('open');
    document.getElementById('planner-drawer-backdrop')?.classList.add('visible');
}

export function plannerCloseDrawer() {
    document.getElementById('planner-lists-drawer')?.classList.remove('open');
    document.getElementById('planner-drawer-backdrop')?.classList.remove('visible');
}

export function plannerSetTab(tab) {
    activeTab = tab;
    document.querySelectorAll('.pw-tab').forEach(el => el.classList.toggle('pw-tab--active', el.dataset.tab === tab));
    updateHeader();
    renderActivePanel();
    // Reload data for the tab
    if (tab === 'events') loadEvents().then(() => renderActivePanel());
}

export function plannerSetFilter(value) {
    filterStatus = value;
    document.querySelectorAll('.p-filter-chip').forEach(el => {
        el.classList.toggle('p-filter-chip--active', el.dataset.filter === value);
    });
    renderActivePanel();
}

// Calendar navigation
export function plannerCalPrev() {
    if (calView === 'month') calDate = new Date(calDate.getFullYear(), calDate.getMonth() - 1, 1);
    else if (calView === 'week') { calDate = new Date(calDate); calDate.setDate(calDate.getDate() - 7); }
    else { calDate = new Date(calDate); calDate.setDate(calDate.getDate() - 1); }
    renderActivePanel();
}
export function plannerCalNext() {
    if (calView === 'month') calDate = new Date(calDate.getFullYear(), calDate.getMonth() + 1, 1);
    else if (calView === 'week') { calDate = new Date(calDate); calDate.setDate(calDate.getDate() + 7); }
    else { calDate = new Date(calDate); calDate.setDate(calDate.getDate() + 1); }
    renderActivePanel();
}
export function plannerCalToday() { calDate = new Date(); renderActivePanel(); }
export function plannerSetCalView(v) {
    calView = v;
    try { localStorage.setItem('plannerCalView', v); } catch {}
    renderActivePanel();
}
export function plannerSelectDay(_dateStr) { }

// Click on a calendar day → open add with that date
export function plannerCalClickDay(dk) {
    calDate = new Date(dk + 'T12:00:00');
    if (calView === 'month') {
        // Switch to day view for that date
        calView = 'day';
        renderActivePanel();
    }
}

// Click on an hour cell → open add with date+hour pre-filled
export function plannerCalClickHour(dk, hour) {
    const dt = new Date(dk + 'T00:00:00');
    dt.setHours(hour, 0, 0, 0);
    plannerOpenAdd(localISOString(dt));
}

export function plannerEventDragStart(event, entryId) {
    dragEventId = Number(entryId);
    event.dataTransfer.effectAllowed = 'move';
    event.currentTarget.classList.add('p-evt--dragging');
}

export function plannerEventDragOver(event) {
    event.preventDefault();
    event.dataTransfer.dropEffect = 'move';
}

export function plannerEventDragEnd(event) {
    dragEventId = null;
    event.currentTarget.classList.remove('p-evt--dragging');
}

async function plannerMoveEventTo(entryId, newStart) {
    const ev = eventsCache.find(x => x.id === Number(entryId));
    if (!ev) return;
    const duration = eventDurationMs(ev);
    const newEnd = new Date(newStart.getTime() + duration);
    const res = await apiCall(`/api/entries/${entryId}`, {
        method: 'PATCH',
        body: {
            start_at: localISOString(newStart),
            end_at: localISOString(newEnd),
        },
    });
    if (!res.ok) {
        showToast('Could not move event', 'error');
        return;
    }
    await loadEvents();
    renderActivePanel();
}

export async function plannerEventDropDay(event, dk) {
    event.preventDefault();
    if (!dragEventId) return;
    const ev = eventsCache.find(x => x.id === dragEventId);
    const oldStart = ev?.start_at ? new Date(ev.start_at) : null;
    const start = new Date(`${dk}T00:00:00`);
    start.setHours(oldStart && !isNaN(oldStart.getTime()) ? oldStart.getHours() : 9, oldStart && !isNaN(oldStart.getTime()) ? oldStart.getMinutes() : 0, 0, 0);
    const eventId = dragEventId;
    dragEventId = null;
    await plannerMoveEventTo(eventId, start);
}

export async function plannerEventDropHour(event, dk, hour) {
    event.preventDefault();
    if (!dragEventId) return;
    const ev = eventsCache.find(x => x.id === dragEventId);
    const oldStart = ev?.start_at ? new Date(ev.start_at) : null;
    const start = new Date(`${dk}T00:00:00`);
    start.setHours(hour, oldStart && !isNaN(oldStart.getTime()) ? oldStart.getMinutes() : 0, 0, 0);
    const eventId = dragEventId;
    dragEventId = null;
    await plannerMoveEventTo(eventId, start);
}

// Create entry — auto-determines type from active tab
export async function plannerCreateEntry() {
    const titleInput = document.getElementById('planner-add-title');
    const dtInput = document.getElementById('planner-add-datetime');
    const eventStartInput = document.getElementById('planner-add-event-start');
    const eventEndInput = document.getElementById('planner-add-event-end');
    const eventColorInput = document.getElementById('planner-add-event-color');
    const eventNotifyInput = document.getElementById('planner-add-event-notify');
    const eventNotifyMinutesInput = document.getElementById('planner-add-event-notify-minutes');
    const contentInput = document.getElementById('planner-add-content');
    const title = titleInput?.value?.trim();
    if (!title) return;
    const dateValue = dtInput?.value || '';
    const eventStartValue = eventStartInput?.value || '';
    const eventEndValue = eventEndInput?.value || '';
    const content = contentInput?.value?.trim() || '';

    // Determine entry type from active tab
    const entryType = activeTab === 'events' ? 'event' : 'task';

    // Need a list_id — use selected or first available
    let listId = selectedListId || (listsCache[0]?.id);
    if (!listId) { showToast('Create a list first', 'error'); return; }

    const body = { list_id: listId, entry_type: entryType, title };
    if (content) body.content = content;

    if (entryType === 'task' && dateValue) {
        body.due_at = dateValue;
    }
    if (entryType === 'event') {
        const startRaw = eventStartValue || dateValue;
        if (!startRaw) {
            showToast('Choose event start time', 'error');
            return;
        }
        const startDt = new Date(startRaw);
        if (isNaN(startDt.getTime())) {
            showToast('Invalid start time', 'error');
            return;
        }
        const endDt = eventEndValue ? new Date(eventEndValue) : addMinutes(startDt, 60);
        if (isNaN(endDt.getTime()) || endDt <= startDt) {
            showToast('End time must be after start time', 'error');
            return;
        }
        body.start_at = localISOString(startDt);
        body.end_at = localISOString(endDt);
        body.event_color = (eventColorInput?.value || '#4f46e5').trim();
        body.event_notify = !!eventNotifyInput?.checked;
        body.event_notify_minutes = parseInt(eventNotifyMinutesInput?.value || '30', 10) || 0;
    }

    const res = await apiCall('/api/entries', { method: 'POST', body });
    if (!res.ok) { showToast('Could not create entry', 'error'); return; }
    if (titleInput) titleInput.value = '';
    if (dtInput) dtInput.value = '';
    if (eventStartInput) eventStartInput.value = '';
    if (eventEndInput) eventEndInput.value = '';
    if (contentInput) contentInput.value = '';
    plannerCloseAdd();
    // Reload relevant data
    if (entryType === 'task') { await loadTodoEntries(); }
    else if (entryType === 'event') { await loadEvents(); }
    renderActivePanel();
}

export function plannerOpenAdd(prefillDatetime) {
    const sheet = document.getElementById('planner-add-sheet');
    const backdrop = document.getElementById('planner-add-backdrop');
    sheet?.classList.add('open');
    backdrop?.classList.add('visible');

    // Update sheet title based on tab
    const sheetTitle = document.getElementById('planner-add-sheet-title');
    if (sheetTitle) {
        sheetTitle.textContent = activeTab === 'events' ? 'New Event' : 'New Task';
    }

    const taskDateRow = document.getElementById('planner-add-task-datetime-row');
    if (taskDateRow) taskDateRow.style.display = activeTab === 'events' ? 'none' : '';
    const eventTimeRow = document.getElementById('planner-add-event-time-row');
    if (eventTimeRow) eventTimeRow.style.display = activeTab === 'events' ? '' : 'none';
    const eventOptionsRow = document.getElementById('planner-add-event-options-row');
    if (eventOptionsRow) eventOptionsRow.style.display = activeTab === 'events' ? '' : 'none';

    // Pre-fill datetime
    const dtInput = document.getElementById('planner-add-datetime');
    if (dtInput && prefillDatetime) dtInput.value = prefillDatetime;
    const eventStartInput = document.getElementById('planner-add-event-start');
    const eventEndInput = document.getElementById('planner-add-event-end');
    if (activeTab === 'events') {
        const startVal = prefillDatetime || localISOString(new Date());
        if (eventStartInput) eventStartInput.value = startVal;
        if (eventEndInput) {
            const s = new Date(startVal);
            eventEndInput.value = isNaN(s.getTime()) ? '' : localISOString(addMinutes(s, 60));
        }
    }

    // Update placeholder
    const titleInput = document.getElementById('planner-add-title');
    if (titleInput) {
        titleInput.placeholder = activeTab === 'events' ? 'Event title…' : 'What needs doing?';
        titleInput.focus();
    }
}

export function plannerCloseAdd() {
    document.getElementById('planner-add-sheet')?.classList.remove('open');
    document.getElementById('planner-add-backdrop')?.classList.remove('visible');
}

export async function plannerToggleDone(entryId) {
    const entry = entriesCache.find(e => e.id === entryId);
    if (!entry || entry.entry_type !== 'task') return;
    const status = entry.task_status === 'done' ? 'todo' : 'done';
    const res = await apiCall(`/api/entries/${entryId}`, { method: 'PATCH', body: { task_status: status } });
    if (res.ok) { await loadTodoEntries(); renderActivePanel(); }
}

export async function plannerDeleteEntry(entryId) {
    if (!(await showConfirm('Delete this entry?'))) return;
    const res = await apiCall(`/api/entries/${entryId}?hard_delete=true`, { method: 'DELETE' });
    if (res.ok) {
        await Promise.all([loadTodoEntries(), loadEvents()]);
        renderActivePanel();
    }
}

export async function plannerCycleType(entryId) {
    const entry = entriesCache.find(e => e.id === entryId) || eventsCache.find(e => e.id === entryId);
    if (!entry) return;
    const next = entry.entry_type === 'task' ? 'event' : 'task';
    const res = await apiCall(`/api/entries/${entryId}/convert`, { method: 'POST', body: { target_type: next } });
    if (res.ok) {
        await Promise.all([loadTodoEntries(), loadEvents()]);
        renderActivePanel();
    }
}

export async function plannerEntryActions(entryId) {
    const entry = entriesCache.find(e => e.id === entryId) || eventsCache.find(e => e.id === entryId);
    if (!entry) return;
    const actions = [];
    if (entry.entry_type === 'task') {
        actions.push(entry.task_status === 'done' ? 'Reopen task' : 'Complete task');
    }
    actions.push('Delete');

    const choice = await _simpleActionMenu(entry.title, actions);
    if (choice === 0 && entry.entry_type === 'task') await plannerToggleDone(entryId);
    else if (choice === actions.length - 1) await plannerDeleteEntry(entryId);
}

async function _simpleActionMenu(title, options) {
    return new Promise(resolve => {
        const overlay = document.createElement('div');
        overlay.className = 'p-action-overlay';
        overlay.innerHTML = `
            <div class="p-action-sheet">
                <div class="p-action-sheet-title">${escapeHtml(title)}</div>
                ${options.map((opt, i) => `<button class="p-action-sheet-btn ${opt === 'Delete' ? 'p-action-sheet-btn--danger' : ''}" data-idx="${i}">${escapeHtml(opt)}</button>`).join('')}
                <button class="p-action-sheet-btn p-action-sheet-cancel">Cancel</button>
            </div>`;
        overlay.addEventListener('click', (e) => {
            const btn = e.target.closest('[data-idx]');
            if (btn) { overlay.remove(); resolve(Number(btn.dataset.idx)); return; }
            if (e.target.closest('.p-action-sheet-cancel') || e.target === overlay) { overlay.remove(); resolve(-1); }
        });
        document.body.appendChild(overlay);
    });
}

// Drag & drop (To-Do only)
export function plannerDragStart(event, entryId) {
    dragEntryId = Number(entryId);
    event.dataTransfer.effectAllowed = 'move';
    event.currentTarget.classList.add('p-entry--dragging');
}
export function plannerDragOver(event) { event.preventDefault(); event.dataTransfer.dropEffect = 'move'; }
export async function plannerDrop(event, targetId) {
    event.preventDefault();
    const target = Number(targetId);
    if (!dragEntryId || dragEntryId === target) { dragEntryId = null; return; }
    const current = sortEntries(entriesCache);
    const from = current.findIndex(e => e.id === dragEntryId);
    const to = current.findIndex(e => e.id === target);
    if (from < 0 || to < 0) return;
    const [moved] = current.splice(from, 1);
    current.splice(to, 0, moved);
    entriesCache = current.map((e, i) => ({ ...e, position: i }));
    renderActivePanel();
    await apiCall('/api/entries/reorder', { method: 'POST', body: { list_id: selectedListId, ordered_entry_ids: entriesCache.map(e => e.id) } });
    dragEntryId = null;
}
export function plannerDragEnd(event) { dragEntryId = null; event.currentTarget.classList.remove('p-entry--dragging'); }
