/** Normalize Hyveview build output: Rollup preserveModules rewrites /static/* to relative paths. */
import { readdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const root = join(import.meta.dirname, '..', 'static', 'hyveview');
const LANG_RUNTIME = '/static/dist/lang.js';

function walk(dir, fn) {
    for (const name of readdirSync(dir)) {
        const full = join(dir, name);
        if (statSync(full).isDirectory()) {
            walk(full, fn);
            continue;
        }
        if (name.endsWith('.js')) fn(full);
    }
}

const fixImport = (code) => code
    .replace(/from\s*(['"])(?:\.\.\/)+static\/dist\//g, 'from $1/static/dist/')
    .replace(/from\s*(['"])\.\/static\/dist\//g, 'from $1/static/dist/')
    // Any lang/index import (relative, absolute, or machine-specific path segments)
    .replace(
        /from\s*(['"])(?:\.\.\/)*[^'"]*\/static\/js\/lang\/index\.js\1/g,
        `from $1${LANG_RUNTIME}$1`,
    )
    .replace(
        /import\s*(['"])(?:\.\.\/)*[^'"]*\/static\/js\/lang\/index\.js\1;?/g,
        `import $1${LANG_RUNTIME}$1;`,
    )
    // Legacy bundled utils copy (pulls lang with broken absolute paths)
    .replace(
        /import\s*(['"])\.\.\/utils\.js\1;?/g,
        '',
    )
    .replace(
        /import\s*(['"])(?:\.\.\/)*[^'"]*\/static\/js\/utils\.js\1;?/g,
        '',
    );

walk(root, (file) => {
    const next = fixImport(readFileSync(file, 'utf8'));
    writeFileSync(file, next);
});

// Orphan: hyveview/js/utils.js was only needed for custom_selects escapeHtml
for (const orphan of [
    join(root, 'js', 'utils.js'),
    join(root, 'js', 'utils.js.map'),
]) {
    try { unlinkSync(orphan); } catch { /* already gone */ }
}
