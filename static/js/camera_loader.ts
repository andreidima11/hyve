/**
 * Shared camera loading overlay (spinner + label). Animation only while loading.
 */
import { escapeHtml } from './utils.js';
import { t } from './lang/index.js';

export function cameraLoaderMarkup(): string {
    const label = escapeHtml(t('dashboard.camera.loading'));
    return `<div class="hv-cam-loading is-visible" data-hv-cam-loader aria-live="polite">
        <div class="hv-cam-loader" data-hv-cam-loader-anim aria-hidden="true">
            <span class="hv-cam-loader__dot"></span>
            <span class="hv-cam-loader__dot"></span>
            <span class="hv-cam-loader__dot"></span>
        </div>
        <span class="hv-cam-loading__label" data-hv-cam-loader-label>${label}</span>
    </div>`;
}

export function showCameraLoaderLoading(loader: Element | null): void {
    if (!loader) return;
    loader.classList.add('is-visible');
    loader.classList.remove('is-error');
    loader.querySelector('[data-hv-cam-loader-anim]')?.classList.remove('hidden');
    const label = loader.querySelector('[data-hv-cam-loader-label]');
    if (label) label.textContent = t('dashboard.camera.loading');
}

export function showCameraLoaderError(loader: Element | null, message?: string): void {
    if (!loader) return;
    loader.classList.add('is-visible', 'is-error');
    loader.querySelector('[data-hv-cam-loader-anim]')?.classList.add('hidden');
    const label = loader.querySelector('[data-hv-cam-loader-label]');
    const text = String(message || '').trim();
    if (label) label.textContent = text || t('entity.render.camera_unavailable');
}

export function hideCameraLoader(loader: Element | null): void {
    if (!loader) return;
    loader.classList.remove('is-visible', 'is-error');
}

/** Wire load/error handlers on img/video inside a camera shell. */
export function bindCameraPreviewLoader(shell: HTMLElement | null): void {
    if (!shell || shell.dataset.cameraLoaderBound === '1') return;
    const loader = shell.querySelector('[data-hv-cam-loader]');
    const media = shell.querySelector('img, video') as HTMLImageElement | HTMLVideoElement | null;
    if (!loader || !media) return;
    shell.dataset.cameraLoaderBound = '1';
    showCameraLoaderLoading(loader);
    media.classList.add('hy-camera-preview-media');

    const onReady = () => {
        media.classList.add('is-ready');
        hideCameraLoader(loader);
    };
    const onFail = () => {
        media.classList.remove('is-ready');
        showCameraLoaderError(loader);
    };

    if (media.tagName === 'VIDEO') {
        const video = media as HTMLVideoElement;
        video.addEventListener('loadeddata', onReady);
        video.addEventListener('error', onFail);
        if (video.readyState >= 2) onReady();
    } else {
        const img = media as HTMLImageElement;
        img.addEventListener('load', () => {
            if (img.naturalWidth > 0) onReady();
        });
        img.addEventListener('error', onFail);
        if (img.complete && img.naturalWidth > 0) onReady();
    }
}

export function bindCameraPreviewLoaders(root: ParentNode = document): void {
    root.querySelectorAll('[data-camera-preview-shell]').forEach((shell) => {
        bindCameraPreviewLoader(shell as HTMLElement);
    });
}
