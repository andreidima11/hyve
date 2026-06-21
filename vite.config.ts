import path from 'node:path';
import type { Plugin } from 'vite';
import { defineConfig } from 'vite';

const root = path.resolve(__dirname);
const sharedJs = path.join(root, 'static/js');
const langModule = path.join(sharedJs, 'lang/index.js');

/** App and Hyveview must share one i18n module (/static/dist/lang.js). */
function externalizeSharedLang(): Plugin {
    return {
        name: 'externalize-shared-lang',
        enforce: 'pre',
        resolveId(source, importer) {
            if (source === '/static/dist/lang.js') {
                return { id: '/static/dist/lang.js', external: true };
            }
            if (source.includes('/lang/index.js') || source.includes('/lang/index.ts')) {
                return { id: '/static/dist/lang.js', external: true };
            }
            if ((source === './lang/index.js' || source === '../lang/index.js' || source === '../../lang/index.js')
                && importer && (importer.includes('/static/js/') || importer.includes('\\static\\js\\'))) {
                return { id: '/static/dist/lang.js', external: true };
            }
            if (importer && path.resolve(path.dirname(importer), source) === langModule) {
                return { id: '/static/dist/lang.js', external: true };
            }
            return null;
        },
        generateBundle(_options, bundle) {
            const fixLang = (code) => code
                .replace(/from"\.\.\/static\/dist\/lang\.js"/g, 'from"/static/dist/lang.js"')
                .replace(/from'\.\.\/static\/dist\/lang\.js'/g, "from'/static/dist/lang.js'")
                .replace(/from"\.\/static\/dist\/lang\.js"/g, 'from"/static/dist/lang.js"')
                .replace(/from'\.\/static\/dist\/lang\.js'/g, "from'/static/dist/lang.js'")
                .replace(/import"\.\.\/static\/dist\/lang\.js"/g, 'import"/static/dist/lang.js"')
                .replace(/import'\.\.\/static\/dist\/lang\.js'/g, "import'/static/dist/lang.js'")
                .replace(/import"\.\/static\/dist\/lang\.js"/g, 'import"/static/dist/lang.js"')
                .replace(/import'\.\/static\/dist\/lang\.js'/g, "import'/static/dist/lang.js'");
            for (const item of Object.values(bundle)) {
                if (item.type !== 'chunk') continue;
                item.code = fixLang(item.code);
            }
        },
    };
}

/** Hyve browser app — bundled ESM (hyveview stays separate custom elements). */
export default defineConfig({
    root,
    base: '/static/dist/',
    plugins: [externalizeSharedLang()],
    build: {
        outDir: path.join(root, 'static/dist'),
        emptyOutDir: true,
        sourcemap: true,
        rollupOptions: {
            input: {
                app: path.join(root, 'static/js/app.ts'),
            },
            output: {
                entryFileNames: '[name].js',
                chunkFileNames: 'chunks/[name]-[hash].js',
                assetFileNames: 'assets/[name]-[hash][extname]',
                paths(id) {
                    if (id === '/static/dist/lang.js') return '/static/dist/lang.js';
                    return id;
                },
            },
            external: (id) => id.startsWith('/static/hyveview') || id === '/static/dist/lang.js',
        },
    },
    resolve: {
        alias: {
            '@hyve': sharedJs,
        },
    },
});
