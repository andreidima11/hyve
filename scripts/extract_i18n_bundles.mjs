#!/usr/bin/env node
/**
 * One-off / repeatable extractor: move decentralised i18n out of static/js/lang/*.js
 * into core/i18n bundles, addons/translations, and per-component translation folders.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const en = (await import(path.join(root, 'static/js/lang/en.js'))).default;
const ro = (await import(path.join(root, 'static/js/lang/ro.js'))).default;

const PLATFORM_BUNDLES = ['cameras', 'updates', 'backup', 'scenes', 'integrations', 'hy'];

function writeJson(filePath, data) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2) + '\n', 'utf8');
}

function mergeInto(filePath, patch) {
  let base = {};
  if (fs.existsSync(filePath)) {
    base = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  }
  writeJson(filePath, deepMerge(base, patch));
}

function deepMerge(base, overlay) {
  const out = { ...base };
  for (const [key, value] of Object.entries(overlay)) {
    if (value && typeof value === 'object' && !Array.isArray(value)
      && out[key] && typeof out[key] === 'object' && !Array.isArray(out[key])) {
      out[key] = deepMerge(out[key], value);
    } else {
      out[key] = value;
    }
  }
  return out;
}

for (const bundle of PLATFORM_BUNDLES) {
  if (!en[bundle]) continue;
  let payload = { ...en[bundle] };
  if (bundle === 'integrations' && payload.catalog) {
    const catalog = { ...payload.catalog };
    delete payload.catalog;
    for (const [key, value] of Object.entries(catalog)) {
      const slug = key.replace(/_desc$/, '');
      const compDir = path.join(root, 'components', slug, 'translations');
      mergeInto(path.join(compDir, 'en.json'), { catalog_desc: value });
      if (ro.integrations?.catalog?.[key]) {
        mergeInto(path.join(compDir, 'ro.json'), { catalog_desc: ro.integrations.catalog[key] });
      }
    }
  }
  writeJson(path.join(root, 'core/i18n', bundle, 'translations', 'en.json'), payload);
  if (ro[bundle]) {
    let roPayload = { ...ro[bundle] };
    if (bundle === 'integrations' && roPayload.catalog) {
      delete roPayload.catalog;
    }
    writeJson(path.join(root, 'core/i18n', bundle, 'translations', 'ro.json'), roPayload);
  }
}

if (en.apps) {
  writeJson(path.join(root, 'addons/translations/en.json'), { apps: en.apps });
}
if (ro.apps) {
  writeJson(path.join(root, 'addons/translations/ro.json'), { apps: ro.apps });
}

// Strip decentralised keys from mother dictionaries (keep core shell only).
const STRIP_TOP = new Set([...PLATFORM_BUNDLES, 'apps']);
for (const dict of ['en.js', 'ro.js']) {
  const filePath = path.join(root, 'static/js/lang', dict);
  let src = fs.readFileSync(filePath, 'utf8');
  const header = src.match(/^[\s\S]*?const (en|ro) = \{/)[0];
  const langVar = dict.startsWith('en') ? 'en' : 'ro';
  const data = langVar === 'en' ? en : ro;
  const kept = { ...data };
  for (const key of STRIP_TOP) delete kept[key];
  if (kept.integrations?.catalog) delete kept.integrations.catalog;
  // Remove mammotion_* from cameras if cameras section kept — we strip whole cameras
  const inner = JSON.stringify(kept, null, 4).slice(1, -1);
  const body = inner
    .split('\n')
    .map((line) => (line ? `    ${line}` : line))
    .join('\n');
  const next = `${header}\n${body}\n};\n\nexport default ${langVar};\n`;
  fs.writeFileSync(filePath, next, 'utf8');
}

console.log('Extracted i18n bundles and trimmed static/js/lang/en.js + ro.js');
