/** Remove emitted .js beside Hyveview .ts before Vite rebuild (avoids index2.js collisions). */
import { readdirSync, statSync, unlinkSync, rmSync } from 'node:fs';
import { join } from 'node:path';

const root = join(import.meta.dirname, '..', 'static', 'hyveview');

function cleanJs(dir) {
    let names;
    try {
        names = readdirSync(dir);
    } catch {
        return;
    }
    for (const name of names) {
        const full = join(dir, name);
        let st;
        try {
            st = statSync(full);
        } catch {
            continue;
        }
        if (st.isDirectory()) {
            cleanJs(full);
            continue;
        }
        if (!name.endsWith('.js') || name.endsWith('.d.ts')) continue;
        try { unlinkSync(full); } catch { /* gone */ }
        try { unlinkSync(`${full}.map`); } catch { /* no map */ }
    }
}

cleanJs(root);
try { rmSync(join(root, 'js'), { recursive: true, force: true }); } catch { /* */ }
