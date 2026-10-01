function readSort() {
  try {
    const by = localStorage.getItem('shelf.sortBy') === 'added' ? 'added' : 'name';
    const stored = localStorage.getItem('shelf.sortAsc');
    const sortAsc = stored == null ? by === 'name' : stored === '1';
    return { sortBy: by, sortAsc };
  } catch {
    return { sortBy: 'name', sortAsc: true };
  }
}

const savedSort = readSort();
const state = {
  items: [],
  tags: [],
  platform: '',
  packaged: false,
  query: '',
  tag: null,
  onlyPinned: false,
  sortBy: savedSort.sortBy,
  sortAsc: savedSort.sortAsc,
  selectedId: null,
  dragDepth: 0,
  removeArmed: false,
  bulkMode: false,
  bulkIds: new Set(),
  bulkRemoveArmed: false,
};

const $ = (id) => document.getElementById(id);
const library = $('library');
const filters = $('filters');
const inspectorOverlay = $('inspector-overlay');
const inspector = $('inspector');
const aliasInput = $('insp-alias');
const tagInput = $('insp-tag');
const todoInput = $('insp-todo');
let toastTimer = 0;
let bulkRemoveTimer = 0;
let selectTimer = 0;
let lastTileClick = { id: 0, at: 0 };

function cancelPendingSelect() {
  clearTimeout(selectTimer);
  selectTimer = 0;
}

const PALETTE = [
  ['#f8efdf', '#7a4e12', '#ead7b4'],
  ['#e8f0e6', '#2c5634', '#c9dcc8'],
  ['#f8e8e3', '#8a3d30', '#e7c9c2'],
  ['#e7edf6', '#2d486e', '#c9d5e8'],
  ['#f3e8f2', '#6a3b66', '#e2cde0'],
  ['#e5f2f0', '#1e5c56', '#c5dfdb'],
];

function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, (char) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  }[char]));
}

function tagStyle(name) {
  let hash = 0;
  for (const char of name) hash = (hash * 33 + char.charCodeAt(0)) >>> 0;
  const [bg, fg, border] = PALETTE[hash % PALETTE.length];
  return `background:${bg};color:${fg};border-color:${border}`;
}

function toast(message) {
  const el = $('toast');
  el.textContent = message;
  el.dataset.show = 'true';
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    el.dataset.show = 'false';
  }, 3200);
}

async function api(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      'X-Shelf': '1',
      ...(options.headers || {}),
    },
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || 'Request failed');
  return data;
}

function selected() {
  return state.items.find((item) => item.id === state.selectedId) || null;
}

function addedStamp(item) {
  const time = Date.parse(item.createdAt);
  return Number.isFinite(time) ? time : 0;
}

function addedDateLabel(item, withTime = false) {
  const time = addedStamp(item);
  if (!time) return '';
  const date = new Date(time);
  const dateText = date.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
  if (!withTime) return dateText;
  const timeText = date.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  return `${dateText} · ${timeText}`;
}

function compareItems(a, b) {
  if (state.sortBy === 'added') {
    const delta = addedStamp(a) - addedStamp(b);
    if (delta) return state.sortAsc ? delta : -delta;
  }
  const byName = a.displayName.localeCompare(b.displayName, undefined, { sensitivity: 'base' });
  return state.sortAsc || state.sortBy === 'added' ? byName : -byName;
}

function visibleItems() {
  const query = state.query.trim().toLowerCase();
  return state.items.filter((item) => {
    if (state.onlyPinned && !item.pinned) return false;
    if (state.tag && !item.tags.some((tag) => tag.name === state.tag)) return false;
    if (!query) return true;
    const haystack = [
      item.displayName,
      item.filename,
      item.alias,
      item.path,
      item.kind,
      ...item.tags.map((tag) => tag.name),
      ...(item.todos || []).map((todo) => todo.text),
    ].filter(Boolean).join('\n').toLowerCase();
    return haystack.includes(query);
  }).sort(compareItems);
}

function persistSort() {
  try {
    localStorage.setItem('shelf.sortBy', state.sortBy);
    localStorage.setItem('shelf.sortAsc', state.sortAsc ? '1' : '0');
  } catch {
    // Private mode can block localStorage.
  }
}

function syncSortBar() {
  const bar = $('sort-bar');
  if (!bar) return;
  bar.querySelectorAll('[data-sort]').forEach((button) => {
    const on = button.dataset.sort === state.sortBy;
    button.classList.toggle('is-on', on);
    const label = button.dataset.sort === 'added' ? 'Added' : 'Name';
    if (!on) {
      button.textContent = label;
      button.title = `Sort by ${label.toLowerCase()}`;
      return;
    }
    const arrow = state.sortAsc ? '↑' : '↓';
    button.textContent = `${label} ${arrow}`;
    button.title = state.sortBy === 'added'
      ? (state.sortAsc ? 'Oldest first. Click to reverse.' : 'Newest first. Click to reverse.')
      : (state.sortAsc ? 'A to Z. Click to reverse.' : 'Z to A. Click to reverse.');
  });
}

function kindLabel(kind) {
  if (kind === 'app') return 'Application';
  if (kind === 'folder') return 'Folder';
  return 'File';
}

function pinIcon(filled) {
  return `<svg viewBox="0 0 24 24" class="h-4 w-4" fill="${filled ? 'currentColor' : 'none'}" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round" aria-hidden="true">
    <path d="M9.2 3.8h5.6l-.8 5.2 2.8 1.8v1.7H7.2v-1.7l2.8-1.8-.8-5.2z"></path>
    <path d="M12 12.5v7.2" stroke-linecap="round"></path>
  </svg>`;
}

function checkIcon() {
  return `<svg viewBox="0 0 16 16" class="h-3 w-3" fill="none" stroke="currentColor" stroke-width="2.2" aria-hidden="true">
    <path d="M3.5 8.2 6.4 11l6.1-6.4" stroke-linecap="round" stroke-linejoin="round"></path>
  </svg>`;
}

function todoBadgeHtml(item) {
  const count = (item.todos || []).length;
  if (!count) return '';
  return `<span class="todo-badge" aria-label="${count} to-do${count === 1 ? '' : 's'}">${count}</span>`;
}

function placeName() {
  if (state.platform === 'win32') return 'File Explorer';
  if (state.platform === 'darwin') return 'Finder';
  return 'your files';
}

function machineName() {
  if (state.platform === 'win32') return 'this PC';
  if (state.platform === 'linux') return 'this computer';
  return 'this Mac';
}

function applyPlatformCopy() {
  document.querySelectorAll('[data-place]').forEach((el) => {
    el.textContent = placeName();
  });
  const rail = document.querySelector('.rail');
  if (rail) rail.textContent = `SHELF · ON ${machineName().toUpperCase()}`;
  const footerDrag = $('footer-drag');
  if (footerDrag) footerDrag.textContent = `Double-click an item to open it. Drag more in from ${placeName()}.`;
  const stored = $('footer-stored');
  if (stored) stored.textContent = `Stored in SQLite on ${machineName()}.`;
  const pathInput = $('path-input');
  if (pathInput && document.activeElement !== pathInput) {
    pathInput.placeholder = state.platform === 'win32'
      ? 'C:\\Program Files\\App\\App.exe'
      : '/Applications/Notes.app';
  }
}

async function refresh() {
  const data = await api('/api/items');
  state.items = data.items;
  state.tags = data.tags;
  if (data.platform) state.platform = data.platform;
  state.packaged = Boolean(data.packaged);
  const quitBtn = $('quit-btn');
  if (quitBtn) quitBtn.classList.toggle('hidden', !state.packaged);
  if (state.selectedId && !state.items.some((item) => item.id === state.selectedId)) {
    state.selectedId = null;
  }
  applyPlatformCopy();
  render();
}

function renderCounts() {
  const pinned = state.items.filter((item) => item.pinned).length;
  const noun = state.items.length === 1 ? 'item' : 'items';
  const pinText = pinned ? ` · ${pinned} pinned` : '';
  $('counts').textContent = state.items.length
    ? `${state.items.length} ${noun}${pinText}. Click to edit. Double-click to open.`
    : `Nothing shelved yet. Drag an application from ${placeName()}.`;
}

function renderFilters() {
  if (!state.items.length) {
    filters.innerHTML = '';
    return;
  }
  const chips = [
    { key: 'all', label: 'All', on: !state.tag && !state.onlyPinned, action: () => { state.tag = null; state.onlyPinned = false; } },
    { key: 'pinned', label: 'Pinned', on: state.onlyPinned, action: () => { state.onlyPinned = !state.onlyPinned; state.tag = null; } },
    ...state.tags.map((tag) => ({
      key: tag.name,
      label: tag.name,
      on: state.tag === tag.name,
      action: () => {
        state.tag = state.tag === tag.name ? null : tag.name;
        state.onlyPinned = false;
      },
    })),
  ];
  filters.innerHTML = chips.map((chip) => `
    <button type="button" data-filter="${esc(chip.key)}" class="filter-chip rounded-full border border-line bg-card px-3 py-1 text-sm text-soft hover:border-ink/30 ${chip.on ? 'is-on' : ''}">
      ${esc(chip.label)}
    </button>
  `).join('');
  filters.querySelectorAll('[data-filter]').forEach((button, index) => {
    button.addEventListener('click', () => {
      chips[index].action();
      render();
    });
  });
}

function restVisibleItems() {
  return visibleItems().filter((item) => !item.pinned);
}

function bulkControlsHtml() {
  if (!state.bulkMode) {
    return `<button type="button" data-bulk-toggle class="rounded-full border border-line px-3 py-1 text-sm text-soft hover:border-ink">Select</button>`;
  }
  const rest = restVisibleItems();
  const n = state.bulkIds.size;
  const allOn = rest.length > 0 && rest.every((item) => state.bulkIds.has(item.id));
  const removeLabel = state.bulkRemoveArmed ? 'Click again to remove' : n ? `Remove ${n}` : 'Remove';
  const pinLabel = n ? `Pin ${n}` : 'Pin';
  return `
    <div class="flex flex-wrap items-center justify-end gap-2">
      <span data-bulk-count class="text-xs text-faint">${n} selected</span>
      <button type="button" data-bulk-all class="rounded-full border border-line px-3 py-1 text-sm text-soft hover:border-ink">${allOn ? 'Clear' : 'Select all'}</button>
      <button type="button" data-bulk-pin class="rounded-full border border-line px-3 py-1 text-sm text-soft hover:border-brass hover:text-brass ${n ? '' : 'opacity-40'}" ${n ? '' : 'disabled'}>${esc(pinLabel)}</button>
      <button type="button" data-bulk-remove class="rounded-full border border-[#e4c4be] px-3 py-1 text-sm text-[#9f3d2f] hover:border-[#9f3d2f] ${n ? '' : 'opacity-40'}" ${n ? '' : 'disabled'}>${esc(removeLabel)}</button>
      <button type="button" data-bulk-done class="rounded-full border border-line px-3 py-1 text-sm hover:border-ink">Done</button>
    </div>
  `;
}

function tileHtml(item, { selectable = false } = {}) {
  const subtitle = item.alias ? item.filename : '';
  const added = addedDateLabel(item);
  const tags = item.tags.slice(0, 3).map((tag) => `
    <button type="button" data-tag="${esc(tag.name)}" class="tag-chip truncate px-2 py-1" style="${tagStyle(tag.name)}">${esc(tag.name)}</button>
  `).join('');
  const extra = item.tags.length > 3 ? `<span class="text-[11px] text-faint">+${item.tags.length - 3}</span>` : '';
  const bulkable = selectable && state.bulkMode && !item.pinned;
  const bulkOn = bulkable && state.bulkIds.has(item.id);
  return `
    <article tabindex="0" data-id="${item.id}" ${bulkable ? 'data-bulk-able' : ''} title="Double-click to open" class="tile group relative flex cursor-default select-none flex-col items-center px-3 pb-4 pt-8 text-center ${item.pinned ? 'is-pinned' : ''} ${item.missing ? 'is-missing' : ''} ${item.id === state.selectedId ? 'is-selected' : ''} ${bulkOn ? 'is-bulk' : ''}" aria-label="${esc(item.displayName)}">
      ${bulkable ? `<button type="button" data-bulk="${item.id}" class="bulk-check ${bulkOn ? 'is-on' : ''} absolute left-2 top-2 z-10 grid h-5 w-5 place-items-center rounded-[6px]" aria-pressed="${bulkOn}" aria-label="Select ${esc(item.displayName)}">${bulkOn ? checkIcon() : ''}</button>` : ''}
      <button type="button" data-pin="${item.id}" class="pin-btn absolute right-2 top-2 z-10 grid h-7 w-7 place-items-center rounded-full text-brass hover:bg-white" aria-label="${item.pinned ? 'Unpin' : 'Pin'} ${esc(item.displayName)}" title="${item.pinned ? 'Unpin' : 'Pin'}">
        ${pinIcon(item.pinned)}
      </button>
      <div class="relative mt-2">
        <div class="icon-well relative overflow-hidden">
          <div class="monogram absolute inset-0 grid place-items-center">${esc(item.displayName.slice(0, 1).toUpperCase())}</div>
          <img src="/api/items/${item.id}/icon" alt="" class="absolute inset-0 h-full w-full object-contain p-1.5" draggable="false" />
        </div>
        ${todoBadgeHtml(item)}
      </div>
      <h3 class="mt-3 line-clamp-2 w-full text-[14px] font-medium leading-tight" title="${esc(item.displayName)}">${esc(item.displayName)}</h3>
      ${subtitle ? `<p class="mt-1 w-full truncate text-[11px] text-faint" title="${esc(subtitle)}">${esc(subtitle)}</p>` : ''}
      ${added ? `<p class="mt-1 w-full truncate text-[11px] text-faint" title="Added ${esc(added)}">${esc(added)}</p>` : ''}
      ${item.missing ? '<p class="mt-1 text-[11px] text-[#9f3d2f]">Missing</p>' : ''}
      ${tags ? `<div class="mt-2 flex max-w-full flex-wrap justify-center gap-1">${tags}${extra}</div>` : ''}
    </article>
  `;
}

function section(title, items, { horizontal = false, selectable = false } = {}) {
  if (!items.length) return '';
  return `
    <section class="shelf-section ${horizontal ? 'shelf-section-x' : 'shelf-section-y'}">
      <div class="mb-3 flex shrink-0 items-center justify-between gap-2">
        <h2 class="text-[11px] font-medium uppercase tracking-[0.22em] text-faint">${esc(title)}</h2>
        ${selectable ? bulkControlsHtml() : ''}
      </div>
      <div class="themed-scroll shelf-row ${horizontal ? 'shelf-row-x' : 'shelf-row-y'}">${items.map((item) => tileHtml(item, { selectable })).join('')}</div>
    </section>
  `;
}

function renderLibrary() {
  const items = visibleItems();
  if (!state.items.length) {
    library.innerHTML = `
      <div class="rounded-[28px] border border-dashed border-[#c9b79a] bg-card/70 px-8 py-16 text-center">
        <div class="mx-auto mb-6 flex w-40 flex-col gap-3" aria-hidden="true">
          <div class="h-2 rounded-full bg-[#d9c7aa]"></div>
          <div class="mx-3 h-2 rounded-full bg-[#e4d3b8]"></div>
          <div class="mx-8 h-2 rounded-full bg-[#eadcc6]"></div>
        </div>
        <h2 class="wordmark text-4xl">The shelf is empty</h2>
        <p class="mx-auto mt-3 max-w-md text-sm leading-relaxed text-soft">Drag an application in from ${esc(placeName())}. Its file name becomes the name. Double-click later to open it.</p>
      </div>
    `;
    return;
  }
  if (!items.length) {
    library.innerHTML = `<p class="rounded-2xl border border-dashed border-line px-6 py-10 text-center text-sm text-soft">Nothing matches this search.</p>`;
    return;
  }
  const pinned = items.filter((item) => item.pinned);
  const rest = items.filter((item) => !item.pinned);
  const splitRest = !state.query && !state.tag && !state.onlyPinned && pinned.length && rest.length;
  const canBulk = !state.onlyPinned && !state.tag && rest.length;
  if (!canBulk && state.bulkMode) {
    state.bulkMode = false;
    state.bulkIds.clear();
    state.bulkRemoveArmed = false;
  }
  for (const id of [...state.bulkIds]) {
    const item = state.items.find((entry) => entry.id === id);
    if (!item || item.pinned) state.bulkIds.delete(id);
  }
  if (state.onlyPinned || (!state.query && !state.tag && pinned.length && !rest.length)) {
    library.innerHTML = section('Pinned', items, { horizontal: true });
  } else if (splitRest) {
    library.innerHTML = section('Pinned', pinned, { horizontal: true }) + section('Everything else', rest, { selectable: true });
  } else {
    const title = state.tag ? state.tag : 'On the shelf';
    library.innerHTML = section(title, items, { selectable: canBulk });
  }
  library.querySelectorAll('img').forEach((img) => {
    img.addEventListener('error', () => { img.remove(); });
  });
  library.querySelectorAll('.themed-scroll').forEach(armThemedScroll);
}

function armThemedScroll(el) {
  if (!el || el.dataset.scrollArmed) return;
  el.dataset.scrollArmed = '1';
  let timer = 0;
  const bump = () => {
    el.classList.add('is-scrolling');
    clearTimeout(timer);
    timer = setTimeout(() => {
      el.classList.remove('is-scrolling');
    }, 1000);
  };
  el.addEventListener('scroll', bump, { passive: true });
  el.addEventListener('pointerenter', bump);
  el.addEventListener('pointermove', bump);
  el.addEventListener('pointerleave', () => {
    clearTimeout(timer);
    timer = setTimeout(() => el.classList.remove('is-scrolling'), 1000);
  });
  if (el.classList.contains('shelf-row-x')) armSmoothHorizontalWheel(el);
}

function armSmoothHorizontalWheel(row) {
  const motion = {
    target: row.scrollLeft,
    current: row.scrollLeft,
    raf: 0,
    driving: false,
  };
  const prefersReduced = window.matchMedia('(prefers-reduced-motion: reduce)');
  const maxScroll = () => Math.max(0, row.scrollWidth - row.clientWidth);
  const tick = () => {
    motion.driving = true;
    motion.target = Math.max(0, Math.min(maxScroll(), motion.target));
    motion.current += (motion.target - motion.current) * 0.22;
    if (Math.abs(motion.target - motion.current) < 0.4) {
      motion.current = motion.target;
      row.scrollLeft = motion.current;
      motion.raf = 0;
      motion.driving = false;
      return;
    }
    row.scrollLeft = motion.current;
    motion.raf = requestAnimationFrame(tick);
  };
  row.addEventListener('wheel', (event) => {
    if (event.ctrlKey) return;
    const absX = Math.abs(event.deltaX);
    const absY = Math.abs(event.deltaY);
    if (absY === 0 && absX === 0) return;
    if (absX > absY) return;
    event.preventDefault();
    let delta = event.deltaY;
    if (event.deltaMode === 1) delta *= 28;
    else if (event.deltaMode === 2) delta *= row.clientWidth * 0.85;
    if (prefersReduced.matches) {
      row.scrollLeft = Math.max(0, Math.min(maxScroll(), row.scrollLeft + delta));
      motion.target = row.scrollLeft;
      motion.current = row.scrollLeft;
      return;
    }
    if (!motion.raf) {
      motion.current = row.scrollLeft;
      motion.target = row.scrollLeft;
    }
    motion.target += delta;
    if (!motion.raf) motion.raf = requestAnimationFrame(tick);
  }, { passive: false });
  row.addEventListener('scroll', () => {
    if (motion.driving) return;
    motion.target = row.scrollLeft;
    motion.current = row.scrollLeft;
  }, { passive: true });
}

function renderInspectorTags(item) {
  $('insp-tags').innerHTML = item.tags.map((tag) => `
    <span class="tag-chip inline-flex items-center gap-1 px-2 py-1" style="${tagStyle(tag.name)}">
      ${esc(tag.name)}
      <button type="button" data-untag="${tag.id}" class="leading-none text-current/70 hover:text-current" aria-label="Remove tag ${esc(tag.name)}">×</button>
    </span>
  `).join('') || '<span class="text-xs text-faint">No tags yet.</span>';

  const query = tagInput.value.trim().toLowerCase();
  const owned = new Set(item.tags.map((tag) => tag.name.toLowerCase()));
  const suggestions = state.tags
    .map((tag) => tag.name)
    .filter((name) => !owned.has(name.toLowerCase()))
    .filter((name) => !query || name.toLowerCase().includes(query))
    .slice(0, 6);
  $('insp-suggestions').innerHTML = suggestions.length ? `
    <span class="w-full text-[11px] text-faint">Add an existing tag</span>
    ${suggestions.map((name) => `
      <button type="button" data-suggest="${esc(name)}" class="tag-chip px-2 py-1" style="${tagStyle(name)}">${esc(name)}</button>
    `).join('')}
  ` : '';
}

function renderInspectorTodos(item) {
  const todos = item.todos || [];
  const done = todos.filter((todo) => todo.done).length;
  $('insp-todo-count').textContent = todos.length ? `${done} of ${todos.length} done` : '';
  const badge = $('insp-todo-badge');
  badge.textContent = todos.length ? String(todos.length) : '';
  badge.classList.toggle('hidden', !todos.length);
  badge.setAttribute('aria-label', todos.length ? `${todos.length} to-do${todos.length === 1 ? '' : 's'}` : '');
  $('insp-todos').innerHTML = todos.map((todo) => `
    <div class="flex items-start gap-2 rounded-lg px-1 py-1.5 hover:bg-[#f6efe4]">
      <button type="button" data-todo-toggle="${todo.id}" class="todo-check ${todo.done ? 'is-done' : ''} mt-0.5 grid h-4 w-4 shrink-0 place-items-center rounded-[5px]" aria-pressed="${todo.done}" aria-label="${todo.done ? 'Mark not done' : 'Mark done'}">
        ${todo.done ? checkIcon() : ''}
      </button>
      <span class="min-w-0 flex-1 break-words text-sm leading-snug ${todo.done ? 'text-faint line-through' : ''}">${esc(todo.text)}</span>
      <button type="button" data-todo-del="${todo.id}" class="rounded-full px-1 leading-none text-faint hover:text-ink" aria-label="Remove to-do ${esc(todo.text)}">×</button>
    </div>
  `).join('') || '<span class="text-xs text-faint">No to-dos yet.</span>';
}

function closeInspector() {
  cancelPendingSelect();
  state.selectedId = null;
  state.removeArmed = false;
  render();
}

function enterBulkMode() {
  cancelPendingSelect();
  state.selectedId = null;
  state.removeArmed = false;
  state.bulkMode = true;
  state.bulkIds = new Set();
  state.bulkRemoveArmed = false;
  render();
}

function exitBulkMode() {
  state.bulkMode = false;
  state.bulkIds.clear();
  state.bulkRemoveArmed = false;
  clearTimeout(bulkRemoveTimer);
  render();
}

function syncBulkToolbar() {
  const rest = restVisibleItems();
  const n = state.bulkIds.size;
  const count = library.querySelector('[data-bulk-count]');
  if (count) count.textContent = `${n} selected`;
  const pin = library.querySelector('[data-bulk-pin]');
  if (pin) {
    pin.disabled = n === 0;
    pin.classList.toggle('opacity-40', n === 0);
    pin.textContent = n ? `Pin ${n}` : 'Pin';
  }
  const remove = library.querySelector('[data-bulk-remove]');
  if (remove) {
    remove.disabled = n === 0;
    remove.classList.toggle('opacity-40', n === 0);
    remove.textContent = state.bulkRemoveArmed ? 'Click again to remove' : n ? `Remove ${n}` : 'Remove';
  }
  const all = library.querySelector('[data-bulk-all]');
  if (all) all.textContent = rest.length && rest.every((item) => state.bulkIds.has(item.id)) ? 'Clear' : 'Select all';
}

function toggleBulk(id) {
  const item = state.items.find((entry) => entry.id === id);
  if (!item || item.pinned) return;
  if (state.bulkIds.has(id)) state.bulkIds.delete(id);
  else state.bulkIds.add(id);
  state.bulkRemoveArmed = false;
  clearTimeout(bulkRemoveTimer);
  const card = library.querySelector(`[data-id="${id}"]`);
  if (card) {
    const on = state.bulkIds.has(id);
    card.classList.toggle('is-bulk', on);
    const check = card.querySelector('[data-bulk]');
    if (check) {
      check.classList.toggle('is-on', on);
      check.setAttribute('aria-pressed', String(on));
      check.innerHTML = on ? checkIcon() : '';
    }
  }
  syncBulkToolbar();
}

async function bulkPin() {
  const ids = [...state.bulkIds];
  if (!ids.length) return;
  state.bulkRemoveArmed = false;
  clearTimeout(bulkRemoveTimer);
  try {
    for (const id of ids) {
      const item = state.items.find((entry) => entry.id === id);
      if (!item || item.pinned) continue;
      await api(`/api/items/${id}`, {
        method: 'PATCH',
        body: JSON.stringify({ pinned: true }),
      });
      state.bulkIds.delete(id);
    }
    toast(ids.length === 1 ? 'Pinned 1 item' : `Pinned ${ids.length} items`);
    await refresh();
  } catch (error) {
    toast(error.message);
    await refresh();
  }
}

async function bulkRemove() {
  const ids = [...state.bulkIds];
  if (!ids.length) return;
  if (!state.bulkRemoveArmed) {
    state.bulkRemoveArmed = true;
    syncBulkToolbar();
    clearTimeout(bulkRemoveTimer);
    bulkRemoveTimer = setTimeout(() => {
      if (!state.bulkRemoveArmed) return;
      state.bulkRemoveArmed = false;
      syncBulkToolbar();
    }, 4000);
    return;
  }
  state.bulkRemoveArmed = false;
  clearTimeout(bulkRemoveTimer);
  try {
    for (const id of ids) {
      await api(`/api/items/${id}`, { method: 'DELETE' });
      state.bulkIds.delete(id);
    }
    toast(ids.length === 1 ? 'Removed 1 item' : `Removed ${ids.length} items`);
    await refresh();
  } catch (error) {
    toast(error.message);
    await refresh();
  }
}

function syncInspector() {
  const item = selected();
  if (!item) {
    inspectorOverlay.classList.add('hidden');
    inspectorOverlay.setAttribute('aria-hidden', 'true');
    document.body.classList.remove('is-inspecting');
    state.removeArmed = false;
    return;
  }
  inspectorOverlay.classList.remove('hidden');
  inspectorOverlay.setAttribute('aria-hidden', 'false');
  document.body.classList.add('is-inspecting');
  const changed = inspector.dataset.id !== String(item.id);
  inspector.dataset.id = String(item.id);
  if (changed) {
    state.removeArmed = false;
    todoInput.value = '';
  }

  $('insp-kind').textContent = kindLabel(item.kind);
  const liveName = document.activeElement === aliasInput
    ? (aliasInput.value.trim() || item.filename)
    : item.displayName;
  $('insp-name').textContent = liveName;
  $('insp-monogram').textContent = liveName.slice(0, 1).toUpperCase();
  const fileLine = $('insp-file');
  if (item.alias) {
    fileLine.hidden = false;
    fileLine.textContent = `File name: ${item.filename}`;
  } else {
    fileLine.hidden = true;
  }
  $('insp-missing').classList.toggle('hidden', !item.missing);
  if (changed || document.activeElement !== aliasInput) {
    aliasInput.value = item.alias || '';
  }
  aliasInput.placeholder = item.filename;
  const added = addedDateLabel(item, true);
  $('insp-added').textContent = added ? `Added ${added}` : '';
  $('insp-added').hidden = !added;
  $('insp-path').textContent = item.path;
  const pinBtn = $('insp-pin');
  pinBtn.innerHTML = `${pinIcon(item.pinned)}<span>${item.pinned ? 'Pinned' : 'Pin to top'}</span>`;
  pinBtn.setAttribute('aria-label', item.pinned ? 'Unpin from top' : 'Pin to top');
  pinBtn.title = item.pinned ? 'Unpin from top' : 'Pin to top';
  pinBtn.classList.toggle('border-brass', item.pinned);
  pinBtn.classList.toggle('text-brass', item.pinned);
  $('insp-remove').textContent = state.removeArmed ? 'Click again to remove' : 'Remove from shelf';

  const icon = $('insp-icon');
  const nextSrc = `/api/items/${item.id}/icon`;
  if (icon.dataset.item !== String(item.id) || (icon.hidden && item.hasIcon)) {
    icon.dataset.item = String(item.id);
    icon.hidden = false;
    icon.src = item.hasIcon ? nextSrc : `${nextSrc}?wait=1`;
  }
  icon.onerror = () => { icon.hidden = true; };
  renderInspectorTags(item);
  renderInspectorTodos(item);
}

function render() {
  renderCounts();
  renderFilters();
  syncSortBar();
  renderLibrary();
  syncInspector();
}

function select(id) {
  state.selectedId = id;
  state.removeArmed = false;
  const cards = library.querySelectorAll('[data-id]');
  if (!cards.length) {
    render();
    return;
  }
  cards.forEach((card) => {
    card.classList.toggle('is-selected', Number(card.dataset.id) === id);
  });
  syncInspector();
}

function scheduleSelect(id) {
  cancelPendingSelect();
  selectTimer = setTimeout(() => {
    selectTimer = 0;
    select(id);
  }, 300);
}

function activateTile(id, detail = 1) {
  const card = library.querySelector(`[data-id="${id}"]`);
  if (state.bulkMode && card?.hasAttribute('data-bulk-able')) {
    toggleBulk(id);
    return;
  }
  const now = Date.now();
  const repeated = lastTileClick.id === id && now - lastTileClick.at <= 500;
  lastTileClick = repeated ? { id: 0, at: 0 } : { id, at: now };
  if (detail >= 2 || repeated) {
    cancelPendingSelect();
    openItem(id);
    return;
  }
  scheduleSelect(id);
}

let lastOpenAt = 0;

async function openItem(id) {
  const now = Date.now();
  if (now - lastOpenAt < 700) return;
  lastOpenAt = now;
  const item = state.items.find((entry) => entry.id === id);
  if (!item) return;
  if (item.missing) {
    toast('That file is no longer at its path.');
    return;
  }
  const card = library.querySelector(`[data-id="${id}"]`);
  card?.classList.add('is-opening');
  try {
    await api(`/api/items/${id}/open`, { method: 'POST', body: '{}' });
    toast(`Opening ${item.displayName}`);
    await refresh();
  } catch (error) {
    toast(error.message);
  } finally {
    card?.classList.remove('is-opening');
  }
}

async function addResult(result) {
  const created = result.added?.length || 0;
  const skipped = result.existing?.length || 0;
  if (result.errors?.length && !created && !skipped) {
    toast(result.errors[0]);
  } else if (created && skipped) {
    toast(`Added ${created}. ${skipped} already on the shelf.`);
  } else if (created) {
    toast(created === 1 ? `Added ${result.added[0].displayName}` : `Added ${created} items`);
  } else if (skipped) {
    toast(skipped === 1 ? `${result.existing[0].displayName} is already on the shelf` : `${skipped} already on the shelf`);
  }
  const focus = result.added?.[0] || result.existing?.[0];
  await refresh();
  if (focus) state.selectedId = focus.id;
  render();
}

function normalizeClientPath(filePath) {
  let value = filePath.trim();
  if (/^\/[A-Za-z]:\//.test(value)) value = value.slice(1);
  return value;
}

function pathsFromDataTransfer(dataTransfer) {
  const raw = [
    dataTransfer.getData('text/uri-list'),
    dataTransfer.getData('text/plain'),
    dataTransfer.getData('text/html'),
    dataTransfer.getData('public.file-url'),
  ].join('\n');
  const paths = [];
  const pushPath = (value) => {
    const filePath = normalizeClientPath(value);
    if (filePath) paths.push(filePath);
  };
  for (const line of raw.split(/\r?\n/)) {
    const text = line.trim().replace(/^"(.*)"$/, '$1');
    if (!text || text.startsWith('#')) continue;
    const href = text.match(/href=["']?(file:\/\/[^"'>\s]+)/i)?.[1];
    const candidate = href || text;
    if (candidate.startsWith('file://')) {
      try {
        let filePath = decodeURIComponent(new URL(candidate).pathname);
        if (filePath.length > 1 && filePath.endsWith('/')) filePath = filePath.slice(0, -1);
        pushPath(filePath);
      } catch {
        // Ignore malformed file URLs from the drag payload.
      }
    } else if (candidate.startsWith('/') || /^[A-Za-z]:[\\/]/.test(candidate) || candidate.startsWith('\\\\')) {
      pushPath(candidate);
    }
  }
  return [...new Set(paths)];
}

function filesFromDataTransfer(dataTransfer) {
  const files = [];
  const seen = new Set();
  const add = (file) => {
    if (!file?.name || seen.has(file.name)) return;
    seen.add(file.name);
    const nativePath = typeof file.path === 'string' && file.path
      ? file.path
      : (typeof file.mozFullPath === 'string' ? file.mozFullPath : '');
    files.push({
      name: file.name,
      size: Number.isFinite(file.size) ? file.size : null,
      lastModified: Number.isFinite(file.lastModified) ? file.lastModified : null,
      path: nativePath ? normalizeClientPath(nativePath) : '',
    });
  };
  for (const file of dataTransfer.files || []) add(file);
  for (const item of dataTransfer.items || []) {
    if (item.kind !== 'file') continue;
    add(item.getAsFile());
  }
  return files;
}

function isFileDrag(event) {
  const types = [...(event.dataTransfer?.types || [])];
  return types.includes('Files') || types.includes('text/uri-list') || types.includes('public.file-url');
}

async function handleDrop(event) {
  const files = filesFromDataTransfer(event.dataTransfer);
  const paths = [...new Set([
    ...pathsFromDataTransfer(event.dataTransfer),
    ...files.map((file) => file.path).filter(Boolean),
  ])];
  const names = files.map((file) => file.name);
  try {
    await addResult(await api('/api/drop', {
      method: 'POST',
      body: JSON.stringify({ paths, names, files }),
    }));
  } catch (error) {
    toast(error.message);
  }
}

function setDragging(active) {
  document.body.classList.toggle('is-dragging', active);
  const overlay = $('drop-overlay');
  overlay.classList.toggle('hidden', !active);
  overlay.classList.toggle('flex', active);
}

function closeAddMenu() {
  $('add-menu').classList.add('hidden');
}

async function pick(kind) {
  closeAddMenu();
  toast(kind === 'application' ? `Choose an application in ${placeName()}…` : `Choose a file in ${placeName()}…`);
  try {
    const result = await api('/api/pick', { method: 'POST', body: JSON.stringify({ kind }) });
    if (result.cancelled) return;
    await addResult(result);
  } catch (error) {
    toast(error.message);
  }
}

async function saveAlias() {
  const item = selected();
  if (!item) return;
  const next = aliasInput.value.trim();
  if (next === (item.alias || '')) return;
  try {
    await api(`/api/items/${item.id}`, {
      method: 'PATCH',
      body: JSON.stringify({ alias: next }),
    });
    await refresh();
  } catch (error) {
    toast(error.message);
  }
}

async function addTag(name) {
  const item = selected();
  const trimmed = name.trim();
  if (!item || !trimmed) return;
  try {
    await api(`/api/items/${item.id}/tags`, {
      method: 'POST',
      body: JSON.stringify({ name: trimmed }),
    });
    tagInput.value = '';
    await refresh();
    tagInput.focus();
  } catch (error) {
    toast(error.message);
  }
}

async function addTodo(text) {
  const item = selected();
  const trimmed = text.trim();
  if (!item || !trimmed) return;
  try {
    await api(`/api/items/${item.id}/todos`, {
      method: 'POST',
      body: JSON.stringify({ text: trimmed }),
    });
    todoInput.value = '';
    await refresh();
    todoInput.focus();
  } catch (error) {
    toast(error.message);
  }
}

function bind() {
  $('search').addEventListener('input', (event) => {
    state.query = event.target.value;
    render();
  });

  $('add-btn').addEventListener('click', (event) => {
    event.stopPropagation();
    $('add-menu').classList.toggle('hidden');
    if (!$('add-menu').classList.contains('hidden')) $('path-input').focus();
  });

  $('sort-bar').addEventListener('click', (event) => {
    const button = event.target.closest('[data-sort]');
    if (!button) return;
    const next = button.dataset.sort === 'added' ? 'added' : 'name';
    if (state.sortBy === next) {
      state.sortAsc = !state.sortAsc;
    } else {
      state.sortBy = next;
      state.sortAsc = next === 'name';
    }
    persistSort();
    render();
  });

  $('quit-btn').addEventListener('click', async () => {
    try {
      await api('/api/quit', { method: 'POST', body: '{}' });
      toast('Shelf has stopped');
      $('quit-btn').classList.add('hidden');
    } catch (error) {
      toast(error.message);
    }
  });

  document.addEventListener('click', (event) => {
    if (!event.target.closest('#add-menu') && !event.target.closest('#add-btn')) closeAddMenu();
  });

  document.querySelectorAll('[data-pick]').forEach((button) => {
    button.addEventListener('click', () => pick(button.dataset.pick));
  });

  $('path-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const filePath = $('path-input').value.trim();
    if (!filePath) return;
    try {
      await addResult(await api('/api/items', { method: 'POST', body: JSON.stringify({ paths: [filePath] }) }));
      $('path-input').value = '';
      closeAddMenu();
    } catch (error) {
      toast(error.message);
    }
  });

  library.addEventListener('click', (event) => {
    const tag = event.target.closest('[data-tag]');
    if (tag) {
      event.stopPropagation();
      state.tag = state.tag === tag.dataset.tag ? null : tag.dataset.tag;
      state.onlyPinned = false;
      render();
      return;
    }
    const pin = event.target.closest('[data-pin]');
    if (pin) {
      event.stopPropagation();
      const id = Number(pin.dataset.pin);
      const item = state.items.find((entry) => entry.id === id);
      if (!item) return;
      api(`/api/items/${id}`, {
        method: 'PATCH',
        body: JSON.stringify({ pinned: !item.pinned }),
      }).then(refresh).catch((error) => toast(error.message));
      return;
    }
    if (event.target.closest('[data-bulk-toggle]')) {
      enterBulkMode();
      return;
    }
    if (event.target.closest('[data-bulk-done]')) {
      exitBulkMode();
      return;
    }
    if (event.target.closest('[data-bulk-all]')) {
      const rest = restVisibleItems();
      const allOn = rest.length > 0 && rest.every((item) => state.bulkIds.has(item.id));
      if (allOn) state.bulkIds.clear();
      else rest.forEach((item) => state.bulkIds.add(item.id));
      state.bulkRemoveArmed = false;
      clearTimeout(bulkRemoveTimer);
      rest.forEach((item) => {
        const card = library.querySelector(`[data-id="${item.id}"]`);
        if (!card) return;
        const on = state.bulkIds.has(item.id);
        card.classList.toggle('is-bulk', on);
        const check = card.querySelector('[data-bulk]');
        if (check) {
          check.classList.toggle('is-on', on);
          check.setAttribute('aria-pressed', String(on));
          check.innerHTML = on ? checkIcon() : '';
        }
      });
      syncBulkToolbar();
      return;
    }
    if (event.target.closest('[data-bulk-pin]')) {
      bulkPin();
      return;
    }
    if (event.target.closest('[data-bulk-remove]')) {
      bulkRemove();
      return;
    }
    const bulk = event.target.closest('[data-bulk]');
    if (bulk) {
      event.stopPropagation();
      toggleBulk(Number(bulk.dataset.bulk));
      return;
    }
    const card = event.target.closest('[data-id]');
    if (!card || event.target.closest('button')) return;
    activateTile(Number(card.dataset.id), event.detail);
  });

  library.addEventListener('dblclick', (event) => {
    if (event.target.closest('button')) return;
    const card = event.target.closest('[data-id]');
    if (!card) return;
    cancelPendingSelect();
    openItem(Number(card.dataset.id));
  });

  library.addEventListener('keydown', (event) => {
    const card = event.target.closest('[data-id]');
    if (!card) return;
    if (event.key === 'Enter') {
      event.preventDefault();
      openItem(Number(card.dataset.id));
    }
    if (event.key === ' ' && state.bulkMode && card.hasAttribute('data-bulk-able')) {
      event.preventDefault();
      toggleBulk(Number(card.dataset.id));
    }
  });

  inspectorOverlay.addEventListener('click', (event) => {
    if (event.target === inspectorOverlay) closeInspector();
  });

  aliasInput.addEventListener('input', () => {
    const item = selected();
    if (!item) return;
    $('insp-name').textContent = aliasInput.value.trim() || item.filename;
  });
  aliasInput.addEventListener('blur', saveAlias);
  aliasInput.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      aliasInput.blur();
    }
  });

  $('insp-pin').addEventListener('click', async () => {
    const item = selected();
    if (!item) return;
    try {
      await api(`/api/items/${item.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ pinned: !item.pinned }),
      });
      await refresh();
    } catch (error) {
      toast(error.message);
    }
  });

  tagInput.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' || event.key === ',') {
      event.preventDefault();
      addTag(tagInput.value.replace(/,/g, ''));
    }
  });
  tagInput.addEventListener('input', () => {
    if (selected()) renderInspectorTags(selected());
  });

  todoInput.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      addTodo(todoInput.value);
    }
  });

  inspector.addEventListener('click', async (event) => {
    const suggest = event.target.closest('[data-suggest]');
    if (suggest) {
      addTag(suggest.dataset.suggest);
      return;
    }
    const untag = event.target.closest('[data-untag]');
    if (untag && selected()) {
      try {
        await api(`/api/items/${selected().id}/tags/${untag.dataset.untag}`, { method: 'DELETE' });
        await refresh();
      } catch (error) {
        toast(error.message);
      }
      return;
    }
    const toggle = event.target.closest('[data-todo-toggle]');
    if (toggle && selected()) {
      const todo = (selected().todos || []).find((entry) => entry.id === Number(toggle.dataset.todoToggle));
      if (!todo) return;
      try {
        await api(`/api/items/${selected().id}/todos/${todo.id}`, {
          method: 'PATCH',
          body: JSON.stringify({ done: !todo.done }),
        });
        await refresh();
      } catch (error) {
        toast(error.message);
      }
      return;
    }
    const removeTodo = event.target.closest('[data-todo-del]');
    if (removeTodo && selected()) {
      try {
        await api(`/api/items/${selected().id}/todos/${removeTodo.dataset.todoDel}`, { method: 'DELETE' });
        await refresh();
      } catch (error) {
        toast(error.message);
      }
    }
  });

  $('insp-open').addEventListener('click', () => {
    if (state.selectedId) openItem(state.selectedId);
  });
  $('insp-reveal').addEventListener('click', async () => {
    if (!state.selectedId) return;
    try {
      await api(`/api/items/${state.selectedId}/reveal`, { method: 'POST', body: '{}' });
    } catch (error) {
      toast(error.message);
    }
  });
  $('insp-copy').addEventListener('click', async () => {
    const item = selected();
    if (!item) return;
    try {
      await navigator.clipboard.writeText(item.path);
      toast('Path copied');
    } catch {
      toast(item.path);
    }
  });
  $('insp-remove').addEventListener('click', async () => {
    const item = selected();
    if (!item) return;
    if (!state.removeArmed) {
      state.removeArmed = true;
      $('insp-remove').textContent = 'Click again to remove';
      setTimeout(() => {
        if (!state.removeArmed) return;
        state.removeArmed = false;
        if (selected()?.id === item.id) $('insp-remove').textContent = 'Remove from shelf';
      }, 2500);
      return;
    }
    try {
      await api(`/api/items/${item.id}`, { method: 'DELETE' });
      state.selectedId = null;
      state.removeArmed = false;
      toast(`Removed ${item.displayName}`);
      await refresh();
    } catch (error) {
      toast(error.message);
    }
  });

  window.addEventListener('dragenter', (event) => {
    if (!isFileDrag(event)) return;
    event.preventDefault();
    state.dragDepth += 1;
    setDragging(true);
    fetch('/api/pasteboard/capture', { method: 'POST', headers: { 'X-Shelf': '1' } }).catch(() => {});
  });
  window.addEventListener('dragover', (event) => {
    if (!isFileDrag(event)) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = 'copy';
  });
  window.addEventListener('dragleave', (event) => {
    if (!isFileDrag(event)) return;
    state.dragDepth = Math.max(0, state.dragDepth - 1);
    if (state.dragDepth === 0) setDragging(false);
  });
  window.addEventListener('drop', (event) => {
    if (!isFileDrag(event)) return;
    event.preventDefault();
    state.dragDepth = 0;
    setDragging(false);
    handleDrop(event);
  });

  window.addEventListener('keydown', (event) => {
    const typing = ['INPUT', 'TEXTAREA'].includes(document.activeElement?.tagName);
    if (event.key === '/' && !typing && !state.selectedId) {
      event.preventDefault();
      $('search').focus();
    }
    if (event.key === 'Escape') {
      closeAddMenu();
      if (state.bulkMode) {
        event.preventDefault();
        exitBulkMode();
        return;
      }
      if (state.selectedId) {
        event.preventDefault();
        closeInspector();
        return;
      }
      if (document.activeElement === $('search') && state.query) {
        state.query = '';
        $('search').value = '';
        render();
      }
    }
  });

  syncSortBar();
  document.querySelectorAll('.inspector-main.themed-scroll, #insp-todos').forEach(armThemedScroll);
}

const requestedId = Number(new URLSearchParams(location.search).get('item'));

bind();
refresh().then(() => {
  if (requestedId && state.items.some((item) => item.id === requestedId)) select(requestedId);
}).catch(() => {
  $('counts').textContent = 'Shelf needs its local server. In this folder, run npm start.';
  toast('Start the server with npm start');
});
