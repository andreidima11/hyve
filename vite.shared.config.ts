import path from 'node:path';
import { defineConfig } from 'vite';

const root = path.resolve(__dirname);
const sharedJs = path.join(root, 'static/js');

/** Shared ESM modules imported by Hyveview at runtime (/static/dist/*). */
export default defineConfig({
    build: {
        outDir: path.join(root, 'static/dist'),
        emptyOutDir: false,
        sourcemap: true,
        lib: {
            entry: {
                api: path.join(sharedJs, 'api.ts'),
                camera_auth: path.join(sharedJs, 'camera_auth.ts'),
                camera_live: path.join(sharedJs, 'camera_live.ts'),
                camera_loader: path.join(sharedJs, 'camera_loader.ts'),
                icon_utils: path.join(sharedJs, 'icon_utils.ts'),
                icon_picker: path.join(sharedJs, 'icon_picker.ts'),
            },
            formats: ['es'],
        },
        rollupOptions: {
            output: {
                entryFileNames: '[name].js',
            },
            external: (id) => id.includes('/static/hyveview'),
        },
    },
    resolve: {
        alias: {
            '@hyve': sharedJs,
        },
    },
});
