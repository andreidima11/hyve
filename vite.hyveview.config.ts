import path from 'node:path';
import { readdirSync, statSync } from 'node:fs';
import type { Plugin } from 'vite';
import { defineConfig } from 'vite';

const root = path.resolve(__dirname);
const hyveviewRoot = path.join(root, 'static/hyveview');
const sharedJsRoot = path.join(root, 'static/js');

/** Map relative hyveview → shell imports to runtime /static/dist URLs. */
const RUNTIME_IMPORTS: Record<string, string> = {
    '../../js/api.js': '/static/dist/api.js',
    '../../../js/api.js': '/static/dist/api.js',
    '../../js/camera_auth.js': '/static/dist/camera_auth.js',
    '../../../js/camera_auth.js': '/static/dist/camera_auth.js',
    '../../js/camera_live.js': '/static/dist/camera_live.js',
    '../../../js/camera_live.js': '/static/dist/camera_live.js',
    '../../js/camera_loader.js': '/static/dist/camera_loader.js',
    '../../../js/camera_loader.js': '/static/dist/camera_loader.js',
    '../../js/icon_utils.js': '/static/dist/icon_utils.js',
    '../../js/icon_picker.js': '/static/dist/icon_picker.js',
};

const LANG_IMPORTS = new Set([
    '../../js/lang/index.js',
    '../../../js/lang/index.js',
]);

const SHARED_TS = new Set([
    'api.ts',
    'camera_auth.ts',
    'camera_live.ts',
    'camera_loader.ts',
    'icon_utils.ts',
    'icon_picker.ts',
]);

function hyveviewRuntimeImports(): Plugin {
    return {
        name: 'hyveview-runtime-imports',
        enforce: 'pre',
        resolveId(source) {
            if (LANG_IMPORTS.has(source)) {
                return { id: '/static/js/lang/index.js', external: true };
            }
            const mapped = RUNTIME_IMPORTS[source];
            if (mapped) return { id: mapped, external: true };
            return null;
        },
    };
}

function isSharedJsModule(id: string): boolean {
    if (!id.includes(`${path.sep}static${path.sep}js${path.sep}`)) return false;
    const base = path.basename(id);
    return SHARED_TS.has(base) || id.includes(`${path.sep}static${path.sep}js${path.sep}lang${path.sep}`);
}

/** Collect Hyveview TS entry points (preserve folder layout in output). */
function hyveviewEntries(dir: string, relBase = ''): Record<string, string> {
    const entries: Record<string, string> = {};
    for (const name of readdirSync(dir)) {
        const full = path.join(dir, name);
        const rel = relBase ? `${relBase}/${name}` : name;
        if (statSync(full).isDirectory()) {
            if (name === 'types' || name === 'js') continue;
            Object.assign(entries, hyveviewEntries(full, rel));
            continue;
        }
        if (!name.endsWith('.ts') || name.endsWith('.d.ts')) continue;
        entries[rel.replace(/\.ts$/, '')] = full;
    }
    return entries;
}

/** Hyveview custom elements — ESM modules mirroring source tree (replaces tsc emit). */
export default defineConfig({
    plugins: [hyveviewRuntimeImports()],
    build: {
        outDir: hyveviewRoot,
        emptyOutDir: false,
        sourcemap: true,
        rollupOptions: {
            input: hyveviewEntries(hyveviewRoot),
            preserveEntrySignatures: 'strict',
            output: {
                format: 'es',
                preserveModules: true,
                preserveModulesRoot: hyveviewRoot,
                entryFileNames: '[name].js',
                paths(id) {
                    if (id.startsWith('/static/')) return id;
                    return id;
                },
            },
            external: (id) => {
                if (id.startsWith('/static/dist/') || id.startsWith('/static/js/lang/')) return true;
                return isSharedJsModule(id);
            },
        },
    },
    resolve: {
        alias: {
            '@hyve': sharedJsRoot,
        },
    },
});
