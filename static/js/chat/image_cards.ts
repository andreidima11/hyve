/**
 * Chat image cards and fullscreen lightbox.
 */

import { t } from '../lang/index.js';
import { escapeHtml } from '../utils.js';

async function downloadImageBlob(src: string, alt: string) {
    try {
        const resp = await fetch(src);
        const blob = await resp.blob();
        const ext = (blob.type || 'image/png').split('/')[1] || 'png';
        const name = (alt && alt !== 'Generated Image' && alt !== 'image' ? alt.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 60) : 'image') + '.' + ext;
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = name;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
    } catch (_) {
        window.open(src, '_blank');
    }
}

/** Wrap <img> tags in chat bubbles with a styled card + action buttons */
export function decorateImages(container: Element | DocumentFragment | null) {
    if (!container) return;
    const content = container instanceof HTMLElement && container.classList.contains('chat-bubble-content')
        ? container
        : (container instanceof Element ? container.querySelector('.chat-bubble-content') : null);
    const root = content || container;
    const imgs = root instanceof Element ? root.querySelectorAll('img') : [];
    imgs.forEach((img) => {
        if (img.closest('.chat-image-card') || img.classList.contains('chat-user-uploaded-image')) return;
        if (img.naturalWidth > 0 && img.naturalWidth < 40) return;

        const src = img.src || '';
        const alt = img.alt || '';

        const card = document.createElement('div');
        card.className = 'chat-image-card';

        const imgWrap = document.createElement('div');
        imgWrap.className = 'chat-image-card-img';
        imgWrap.addEventListener('click', () => openImageLightbox(src, alt));

        const actions = document.createElement('div');
        actions.className = 'chat-image-card-actions';

        const dlBtn = document.createElement('button');
        dlBtn.type = 'button';
        dlBtn.className = 'chat-image-action-btn';
        dlBtn.title = t('chat.image_download') || 'Download';
        dlBtn.innerHTML = '<i class="fas fa-arrow-down"></i>';
        dlBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            downloadImageBlob(src, alt);
        });

        const shareBtn = document.createElement('button');
        shareBtn.type = 'button';
        shareBtn.className = 'chat-image-action-btn';
        shareBtn.title = t('chat.image_share') || 'Copy link';
        shareBtn.innerHTML = '<i class="fas fa-share-alt"></i>';
        shareBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            const fullUrl = new URL(src, window.location.origin).href;
            if (navigator.share) {
                navigator.share({ title: alt || 'Image', url: fullUrl }).catch(() => {});
            } else {
                navigator.clipboard.writeText(fullUrl).then(() => {
                    shareBtn.innerHTML = '<i class="fas fa-check"></i>';
                    setTimeout(() => { shareBtn.innerHTML = '<i class="fas fa-share-alt"></i>'; }, 1500);
                }).catch(() => {});
            }
        });

        const expandBtn = document.createElement('button');
        expandBtn.type = 'button';
        expandBtn.className = 'chat-image-action-btn';
        expandBtn.title = t('chat.image_expand') || 'Expand';
        expandBtn.innerHTML = '<i class="fas fa-expand"></i>';
        expandBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            openImageLightbox(src, alt);
        });

        actions.appendChild(dlBtn);
        actions.appendChild(shareBtn);
        actions.appendChild(expandBtn);

        img.parentNode?.insertBefore(card, img);
        imgWrap.appendChild(img);
        imgWrap.appendChild(actions);
        card.appendChild(imgWrap);

        if (alt && alt !== 'Generated Image' && alt !== 'image') {
            const caption = document.createElement('div');
            caption.className = 'chat-image-card-caption';
            caption.textContent = alt;
            card.appendChild(caption);
        }
    });
}

/** Full-screen lightbox for image preview */
export function openImageLightbox(src: string, alt: string) {
    document.getElementById('chat-image-lightbox')?.remove();

    const overlay = document.createElement('div');
    overlay.id = 'chat-image-lightbox';
    overlay.className = 'chat-image-lightbox';

    overlay.innerHTML = `
        <div class="chat-lightbox-backdrop"></div>
        <div class="chat-lightbox-content">
            <img src="${escapeHtml(src)}" alt="${escapeHtml(alt)}" class="chat-lightbox-img" />
            <div class="chat-lightbox-toolbar">
                <button type="button" class="chat-lightbox-btn chat-lightbox-dl" title="${escapeHtml(t('chat.image_download') || 'Download')}">
                    <i class="fas fa-arrow-down"></i>
                </button>
                <button type="button" class="chat-lightbox-btn chat-lightbox-share" title="${escapeHtml(t('chat.image_share') || 'Copy link')}">
                    <i class="fas fa-share-alt"></i>
                </button>
                <button type="button" class="chat-lightbox-btn chat-lightbox-close" title="${escapeHtml(t('common.close') || 'Close')}">
                    <i class="fas fa-times"></i>
                </button>
            </div>
        </div>`;

    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') closeLightbox(); };
    const closeLightbox = () => { overlay.remove(); document.removeEventListener('keydown', onKey); };

    overlay.querySelector('.chat-lightbox-backdrop')?.addEventListener('click', closeLightbox);
    overlay.querySelector('.chat-lightbox-close')?.addEventListener('click', closeLightbox);

    overlay.querySelector('.chat-lightbox-dl')?.addEventListener('click', () => {
        downloadImageBlob(src, alt);
    });

    overlay.querySelector('.chat-lightbox-share')?.addEventListener('click', () => {
        const fullUrl = new URL(src, window.location.origin).href;
        if (navigator.share) {
            navigator.share({ title: alt || 'Image', url: fullUrl }).catch(() => {});
        } else {
            navigator.clipboard.writeText(fullUrl).then(() => {
                const btn = overlay.querySelector('.chat-lightbox-share');
                if (btn) btn.innerHTML = '<i class="fas fa-check"></i>';
                setTimeout(() => {
                    const b = overlay.querySelector('.chat-lightbox-share');
                    if (b) b.innerHTML = '<i class="fas fa-share-alt"></i>';
                }, 1500);
            }).catch(() => {});
        }
    });

    document.addEventListener('keydown', onKey);

    document.body.appendChild(overlay);
    requestAnimationFrame(() => overlay.classList.add('chat-image-lightbox-visible'));
}
