// Icon autocomplete picker for Font Awesome (fa-…) and Material Design Icons (mdi:…).
//
// Usage:
//   - Mark any <input> with `data-icon-picker` and the picker auto-attaches.
//   - User types `fa-h` → suggestions for FA icons starting with "h".
//   - User types `mdi:h` (or `mdi-h`) → suggestions for MDI icons.
//   - With no prefix, both libraries are searched.
//   - On select, the input value is set in the canonical form expected by the
//     existing renderers (`fa-NAME`, `fas fa-NAME` if input already used a
//     style prefix, or `mdi:NAME` for MDI).
//
// The icon database is built once by walking the loaded Font Awesome and MDI
// stylesheets and collecting class names whose rule sets define `content:`
// (i.e. real glyph definitions). This keeps the list automatically in sync
// with whatever versions of the fonts are loaded — no hard-coded list to
// maintain.

const FA_CSS_URL = '/static/vendor/fontawesome/css/all.min.css';
const FA_BRANDS_CSS_URL = '/static/vendor/fontawesome/css/brands.min.css';
const MDI_CSS_URL = '/static/vendor/mdi/css/materialdesignicons.min.css';

interface IconDatabase {
    fa: string[];
    faBrands: Set<string>;
    mdi: string[];
}

interface IconSearchResult {
    lib: 'fa' | 'mdi';
    name: string;
    style: string;
    score: number;
}

interface ParsedIconQuery {
    lib: 'fa' | 'mdi';
    term: string;
    stylePrefix: string;
    explicitLib: boolean;
}

let _dbPromise: Promise<IconDatabase> | null = null;

function _extractNames(cssText: string, prefix: string): string[] {
  const re = new RegExp('\\.' + prefix + '-([a-z0-9-]+):{1,2}before', 'gi');
  const out = new Set<string>();
  let m: RegExpExecArray | null;
  while ((m = re.exec(cssText)) !== null) {
    out.add(m[1].toLowerCase());
  }
  return Array.from(out).sort();
}

async function _fetchText(url: string): Promise<string> {
  try {
    const r = await fetch(url, { cache: 'force-cache' });
    if (!r.ok) return '';
    return await r.text();
  } catch (_e) {
    return '';
  }
}

export function loadIconDatabase(): Promise<IconDatabase> {
  if (_dbPromise) return _dbPromise;
  _dbPromise = (async () => {
    const [faCss, faBrandsCss, mdiCss] = await Promise.all([
      _fetchText(FA_CSS_URL),
      _fetchText(FA_BRANDS_CSS_URL),
      _fetchText(MDI_CSS_URL),
    ]);
    const faBrands = _extractNames(faBrandsCss, 'fa');
    const db: IconDatabase = {
      fa: _extractNames(faCss, 'fa'),
      faBrands: new Set(faBrands),
      mdi: _extractNames(mdiCss, 'mdi'),
    };
    if (typeof console !== 'undefined') {
      console.info(`[icon-picker] loaded fa=${db.fa.length} faBrands=${faBrands.length} mdi=${db.mdi.length}`);
    }
    return db;
  })();
  return _dbPromise;
}

function _parseQuery(raw: string): ParsedIconQuery {
  const value = (raw || '').trim();
  const mdiMatch = value.match(/^mdi[:\-]\s*(.*)$/i);
  if (mdiMatch) {
    return { lib: 'mdi', term: mdiMatch[1].toLowerCase().trim(), stylePrefix: '', explicitLib: true };
  }
  let faStyle = '';
  let term = value.toLowerCase();
  const styleMatch = term.match(/^(fa-(?:solid|regular|brands|light|duotone|sharp)|fass?|far|fab|fal|fad)\s+(.*)$/);
  if (styleMatch) {
    faStyle = styleMatch[1];
    term = styleMatch[2];
  }
  const hasFaPrefix = /^fa-/.test(term);
  term = term.replace(/^fa-/, '').trim();
  return { lib: 'fa', term, stylePrefix: faStyle, explicitLib: !!faStyle || hasFaPrefix };
}

function _scoreMatch(name: string, term: string): number {
  if (!term) return 1;
  const idx = name.indexOf(term);
  if (idx < 0) return -1;
  if (idx === 0) return 1000 - name.length;
  if (name[idx - 1] === '-') return 500 - name.length;
  return 100 - idx;
}

function _searchBucket(db: IconDatabase, lib: 'fa' | 'mdi', term: string, preferredLib: 'fa' | 'mdi'): IconSearchResult[] {
  const list = lib === 'mdi' ? db.mdi : db.fa;
  const results: IconSearchResult[] = [];
  for (const name of list) {
    const score = _scoreMatch(name, term);
    if (score < 0) continue;
    const libBias = lib === preferredLib ? 50 : 0;
    const style = lib === 'fa' && db.faBrands && db.faBrands.has(name) ? 'fab' : 'fas';
    results.push({ lib, name, style, score: score + libBias });
  }
  results.sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));
  return results;
}

function _interleaveResults(groups: IconSearchResult[][], limit: number): IconSearchResult[] {
  const out: IconSearchResult[] = [];
  for (let idx = 0; out.length < limit; idx += 1) {
    let added = false;
    for (const group of groups) {
      if (group[idx]) {
        out.push(group[idx]);
        added = true;
        if (out.length >= limit) break;
      }
    }
    if (!added) break;
  }
  return out;
}

function _search(db: IconDatabase, query: ParsedIconQuery, limit = 60): IconSearchResult[] {
  const { lib, term, explicitLib } = query;
  if (explicitLib) {
    return _searchBucket(db, lib, term, lib).slice(0, limit);
  }
  const fa = _searchBucket(db, 'fa', term, 'fa').slice(0, Math.ceil(limit / 2));
  const mdi = _searchBucket(db, 'mdi', term, 'mdi').slice(0, Math.floor(limit / 2));
  return _interleaveResults([fa, mdi], limit);
}

function _renderIcon(item: IconSearchResult): string {
  if (item.lib === 'mdi') {
    return `<span class="mdi mdi-${item.name}"></span>`;
  }
  return `<i class="${item.style || 'fas'} fa-${item.name}"></i>`;
}

function _formatValue(input: HTMLInputElement, item: IconSearchResult, query: ParsedIconQuery): string {
  if (item.lib === 'mdi') return `mdi:${item.name}`;
  if (query.stylePrefix) return `${query.stylePrefix} fa-${item.name}`;
  if (item.style === 'fab') return `fab fa-${item.name}`;
  const cur = (input.value || '').trim();
  const prev = cur.match(/^(fa-(?:solid|regular|brands|light|duotone|sharp)|fass?|far|fab|fal|fad)\s+/);
  if (prev) return `${prev[1]} fa-${item.name}`;
  return `fa-${item.name}`;
}

function _ensurePopover(): HTMLElement {
  let pop = document.getElementById('icon-picker-popover');
  if (pop) return pop;
  pop = document.createElement('div');
  pop.id = 'icon-picker-popover';
  pop.className = 'icon-picker-popover';
  pop.setAttribute('role', 'listbox');
  pop.style.display = 'none';
  document.body.appendChild(pop);
  return pop;
}

function _positionPopover(pop: HTMLElement, input: HTMLInputElement) {
  const rect = input.getBoundingClientRect();
  const width = Math.max(rect.width, 280);
  pop.style.top = `${rect.bottom + 4}px`;
  pop.style.left = `${rect.left}px`;
  pop.style.width = `${width}px`;
}

let _activeInput: HTMLInputElement | null = null;
let _activeItems: IconSearchResult[] = [];
let _activeIndex = -1;

function _hidePopover() {
  const pop = document.getElementById('icon-picker-popover');
  if (pop) pop.style.display = 'none';
  _activeInput = null;
  _activeItems = [];
  _activeIndex = -1;
}

function _highlight(pop: HTMLElement, idx: number) {
  const nodes = pop.querySelectorAll('.icon-picker-item');
  nodes.forEach((n, i) => {
    n.classList.toggle('is-active', i === idx);
    if (i === idx) n.scrollIntoView({ block: 'nearest' });
  });
  _activeIndex = idx;
}

async function _renderResults(input: HTMLInputElement) {
  const pop = _ensurePopover();
  const db = await loadIconDatabase();
  const query = _parseQuery(input.value);
  const items = _search(db, query);
  _activeItems = items;

  if (!items.length) {
    pop.innerHTML = `<div class="icon-picker-empty">Niciun rezultat</div>`;
  } else {
    const html = items.map((it, i) => `
      <button type="button" class="icon-picker-item${i === 0 ? ' is-active' : ''}" data-idx="${i}" role="option">
        <span class="icon-picker-item__glyph">${_renderIcon(it)}</span>
        <span class="icon-picker-item__name">${it.lib === 'mdi' ? 'mdi:' : (it.style === 'fab' ? 'fab fa-' : 'fa-')}${it.name}</span>
        <span class="icon-picker-item__lib">${it.lib.toUpperCase()}</span>
      </button>`).join('');
    pop.innerHTML = `
      <div class="icon-picker-meta">
        <span>${items.length} rezultat${items.length === 1 ? '' : 'e'}</span>
        <span class="icon-picker-meta__hint">FA: ${db.fa.length} • Brands: ${db.faBrands ? db.faBrands.size : 0} • MDI: ${db.mdi.length}</span>
      </div>
      <div class="icon-picker-list">${html}</div>`;
  }

  _positionPopover(pop, input);
  pop.style.display = 'block';
  _activeIndex = items.length ? 0 : -1;

  pop.querySelectorAll('.icon-picker-item').forEach((node) => {
    node.addEventListener('mousedown', (ev) => {
      ev.preventDefault();
      const idx = Number((node as HTMLElement).dataset.idx);
      _commit(input, idx);
    });
    node.addEventListener('mouseenter', () => {
      _highlight(pop, Number((node as HTMLElement).dataset.idx));
    });
  });
}

function _commit(input: HTMLInputElement, idx: number) {
  const item = _activeItems[idx];
  if (!item) return;
  const query = _parseQuery(input.value);
  input.value = _formatValue(input, item, query);
  input.dispatchEvent(new Event('input', { bubbles: true }));
  input.dispatchEvent(new Event('change', { bubbles: true }));
  _hidePopover();
  input.focus();
}

export function attachIconPicker(input: HTMLInputElement | null) {
  if (!input || input.dataset.iconPickerBound === '1') return;
  input.dataset.iconPickerBound = '1';
  input.setAttribute('autocomplete', 'off');
  input.setAttribute('autocorrect', 'off');
  input.setAttribute('autocapitalize', 'off');
  input.setAttribute('spellcheck', 'false');

  const open = () => {
    _activeInput = input;
    _renderResults(input);
  };

  input.addEventListener('focus', open);
  input.addEventListener('input', () => {
    if (_activeInput !== input) _activeInput = input;
    _renderResults(input);
  });
  input.addEventListener('keydown', (ev) => {
    if (_activeInput !== input) return;
    if (ev.key === 'ArrowDown') {
      ev.preventDefault();
      const next = Math.min((_activeIndex < 0 ? -1 : _activeIndex) + 1, _activeItems.length - 1);
      const pop = document.getElementById('icon-picker-popover');
      if (pop) _highlight(pop, next);
    } else if (ev.key === 'ArrowUp') {
      ev.preventDefault();
      const prev = Math.max(_activeIndex - 1, 0);
      const pop = document.getElementById('icon-picker-popover');
      if (pop) _highlight(pop, prev);
    } else if (ev.key === 'Enter') {
      if (_activeIndex >= 0 && _activeItems.length) {
        ev.preventDefault();
        _commit(input, _activeIndex);
      }
    } else if (ev.key === 'Escape') {
      _hidePopover();
    }
  });
  input.addEventListener('blur', () => {
    setTimeout(() => { if (_activeInput === input) _hidePopover(); }, 120);
  });
}

function _autoAttach(root: ParentNode) {
  root.querySelectorAll('input[data-icon-picker]').forEach((node) => {
    attachIconPicker(node as HTMLInputElement);
  });
}

function _initObserver() {
  const obs = new MutationObserver((mutations) => {
    for (const m of mutations) {
      m.addedNodes && m.addedNodes.forEach((node) => {
        if (node.nodeType !== 1) return;
        const el = node as Element;
        if (el.matches('input[data-icon-picker]')) attachIconPicker(el as HTMLInputElement);
        _autoAttach(el);
      });
    }
  });
  obs.observe(document.body, { childList: true, subtree: true });
}

export function initIconPicker() {
  _autoAttach(document);
  _initObserver();
  document.addEventListener('mousedown', (ev) => {
    const pop = document.getElementById('icon-picker-popover');
    if (!pop || pop.style.display === 'none') return;
    if (pop.contains(ev.target as Node)) return;
    if (_activeInput && _activeInput.contains(ev.target as Node)) return;
    _hidePopover();
  });
  const reposition = () => {
    const pop = document.getElementById('icon-picker-popover');
    if (pop && pop.style.display !== 'none' && _activeInput) _positionPopover(pop, _activeInput);
  };
  window.addEventListener('resize', reposition);
  document.addEventListener('scroll', reposition, true);
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initIconPicker, { once: true });
} else {
  initIconPicker();
}
