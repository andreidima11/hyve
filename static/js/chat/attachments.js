/**
 * Chat message attachments — image resize/compress and document preview.
 */
import { t } from '../lang/index.js';
import { escapeHtml } from '../utils.js';
const IMG_MAX_DIM = 1536;
const IMG_MAX_BYTES = 1500000;
const IMG_QUALITY = 0.82;
let attachedImageDataUrl = null;
let attachedDocumentText = null;
let attachedDocumentFileName = null;
let _imageResizePromise = null;
function _resizeImage(dataUrl) {
    return new Promise((resolve) => {
        const img = new Image();
        img.onload = () => {
            let { width: w, height: h } = img;
            if (w > IMG_MAX_DIM || h > IMG_MAX_DIM) {
                const ratio = Math.min(IMG_MAX_DIM / w, IMG_MAX_DIM / h);
                w = Math.round(w * ratio);
                h = Math.round(h * ratio);
            }
            const canvas = document.createElement('canvas');
            canvas.width = w;
            canvas.height = h;
            const ctx = canvas.getContext('2d');
            if (!ctx) {
                resolve(dataUrl);
                return;
            }
            ctx.drawImage(img, 0, 0, w, h);
            let quality = IMG_QUALITY;
            let result = canvas.toDataURL('image/jpeg', quality);
            while (result.length > IMG_MAX_BYTES && quality > 0.3) {
                quality -= 0.1;
                result = canvas.toDataURL('image/jpeg', quality);
            }
            if (result.length > IMG_MAX_BYTES) {
                const shrink = Math.sqrt(IMG_MAX_BYTES / result.length);
                canvas.width = Math.round(w * shrink);
                canvas.height = Math.round(h * shrink);
                ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
                result = canvas.toDataURL('image/jpeg', 0.7);
            }
            resolve(result);
        };
        img.onerror = () => resolve(dataUrl);
        img.src = dataUrl;
    });
}
export function documentIconClass(fileName) {
    const n = (fileName || '').toLowerCase();
    if (n.endsWith('.pdf'))
        return 'fa-file-pdf';
    if (n.endsWith('.docx') || n.endsWith('.doc'))
        return 'fa-file-word';
    if (n.endsWith('.txt'))
        return 'fa-file-lines';
    return 'fa-file-alt';
}
function _updateDocumentPreview() {
    const el = document.getElementById('chat-document-preview');
    if (!el)
        return;
    if (!attachedDocumentText) {
        el.classList.add('hidden');
        el.innerHTML = '';
        return;
    }
    el.classList.remove('hidden');
    const name = attachedDocumentFileName || 'document';
    const iconClass = documentIconClass(name);
    el.innerHTML = `<span class="chat-document-name"><i class="fas ${iconClass}"></i> ${escapeHtml(name)}</span><button type="button" class="chat-document-remove" aria-label="${escapeHtml(t('chat.remove_document') || 'Remove document')}"><i class="fas fa-times"></i></button>`;
    const btn = el.querySelector('.chat-document-remove');
    if (btn)
        btn.addEventListener('click', () => clearAttachedDocument());
}
function _updateImagePreview() {
    const el = document.getElementById('chat-image-preview');
    if (!el)
        return;
    if (!attachedImageDataUrl) {
        el.classList.add('hidden');
        el.innerHTML = '';
        return;
    }
    el.classList.remove('hidden');
    el.innerHTML = '<img src="" alt="" /><button type="button" class="chat-image-remove" aria-label="Remove"><i class="fas fa-times"></i></button>';
    const img = el.querySelector('img');
    if (img)
        img.src = attachedImageDataUrl;
    const btn = el.querySelector('.chat-image-remove');
    if (btn)
        btn.addEventListener('click', () => clearAttachedImage());
}
export async function addAttachedImage(dataUrl) {
    attachedImageDataUrl = dataUrl;
    _updateImagePreview();
    const resizeP = _resizeImage(dataUrl);
    _imageResizePromise = resizeP;
    const optimized = await resizeP;
    if (attachedImageDataUrl === dataUrl) {
        attachedImageDataUrl = optimized;
    }
    if (_imageResizePromise === resizeP)
        _imageResizePromise = null;
}
export function clearAttachedImage() {
    attachedImageDataUrl = null;
    _imageResizePromise = null;
    _updateImagePreview();
}
export async function waitForImageReady() {
    if (_imageResizePromise)
        await _imageResizePromise;
}
export function getAttachedImageDataUrl() {
    return attachedImageDataUrl;
}
export function getAttachedImageBase64() {
    if (!attachedImageDataUrl)
        return null;
    const idx = attachedImageDataUrl.indexOf(';base64,');
    if (idx !== -1)
        return attachedImageDataUrl.substring(idx + 8);
    return attachedImageDataUrl;
}
export function addAttachedDocument(text, fileName) {
    attachedDocumentText = text;
    attachedDocumentFileName = fileName || null;
    _updateDocumentPreview();
}
export function clearAttachedDocument() {
    attachedDocumentText = null;
    attachedDocumentFileName = null;
    _updateDocumentPreview();
}
export function getAttachedDocumentText() {
    return attachedDocumentText;
}
export function getAttachedDocumentFileName() {
    return attachedDocumentFileName;
}
