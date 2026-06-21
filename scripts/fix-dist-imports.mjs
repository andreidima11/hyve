/** Normalize lang.js imports in Vite dist output. Chunk URLs are left relative — Vite `base` prepends /static/dist/. */
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const dist = join(import.meta.dirname, '..', 'static', 'dist');

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
    .replace(/from\s*(['"])(?:\.\.\/)+static\/dist\/lang\.js\1/g, 'from $1/static/dist/lang.js')
    .replace(/from\s*(['"])\.\/static\/dist\/lang\.js\1/g, 'from $1/static/dist/lang.js')
    .replace(/import\s*(['"])(?:\.\.\/)+static\/dist\/lang\.js\1/g, 'import $1/static/dist/lang.js')
    .replace(/import\s*(['"])\.\/static\/dist\/lang\.js\1/g, 'import $1/static/dist/lang.js')
    .replace(/from\s*(['"])(?:\.\.\/)+static\/dist\//g, 'from $1/static/dist/');

let changed = 0;
walk(dist, (file) => {
    const prev = readFileSync(file, 'utf8');
    const next = fixImport(prev);
    if (next !== prev) {
        writeFileSync(file, next);
        changed += 1;
    }
});

if (changed) {
    console.log(`fix-dist-imports: updated ${changed} file(s) under static/dist/`);
}
