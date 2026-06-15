/** Normalize Hyveview build output: Rollup preserveModules rewrites /static/* to relative paths. */
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const root = join(import.meta.dirname, '..', 'static', 'hyveview');

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
    .replace(/from\s*(['"])(?:\.\.\/)+static\/js\/lang\//g, 'from $1/static/js/lang/')
    .replace(/from\s*(['"])\.\/static\/js\/lang\//g, 'from $1/static/js/lang/');

walk(root, (file) => {
    const next = fixImport(readFileSync(file, 'utf8'));
    writeFileSync(file, next);
});
