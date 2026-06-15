import path from 'node:path';
import { defineConfig } from 'vite';

const root = path.resolve(__dirname);
const sharedJs = path.join(root, 'static/js');

/** Hyve browser app — bundled ESM (hyveview stays separate custom elements). */
export default defineConfig({
    root,
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
            },
            external: (id) => id.startsWith('/static/hyveview'),
        },
    },
    resolve: {
        alias: {
            '@hyve': sharedJs,
        },
    },
});
