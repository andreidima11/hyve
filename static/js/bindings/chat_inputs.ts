/** Direct chat DOM bindings — send, attach, keyboard, admin form. */

import { authToken } from '../api.js';
import { showToast } from '../utils.js';
import { t } from '../lang/index.js';
import { sendMessage, stopStreaming, currentSessionId, addAttachedImage, addAttachedDocument, handleSlashInput, handleSlashKeydown } from '../chat.js';
import { closeModelSelector } from '../chat/model_selector.js';
import { createUser, loadAdminUsers, newChatSession } from '../features.js';
import { _appEl, _errMsg } from '../boot/index.js';

export function initChatInputBindings(): void {
// 4. Bind evenimente Chat

const btnSend = document.getElementById('btn-send');
if (btnSend) btnSend.onclick = () => {
    if (btnSend.classList.contains('streaming')) stopStreaming();
    else sendMessage();
};

const btnAttach = document.getElementById('btn-attach');

const balloon = document.getElementById('chat-attach-balloon');

const imageInput = document.getElementById('chat-image-input') as HTMLInputElement | null;

const cameraInput = document.getElementById('chat-camera-input') as HTMLInputElement | null;

const documentInput = document.getElementById('chat-document-input') as HTMLInputElement | null;
if (btnAttach && balloon) {
    btnAttach.title = t('chat.attach_image');
    btnAttach.setAttribute('aria-label', t('chat.attach_image'));
    btnAttach.onclick = (e) => {
        e.stopPropagation();

        const singleAttach = btnAttach.getAttribute('data-single-attach');
        if (singleAttach === 'document') {
            if (documentInput) documentInput.click();
            return;
        }
        if (singleAttach === 'image') {
            if (imageInput) imageInput.click();
            return;
        }

        const isOpen = !balloon.classList.contains('hidden');
        balloon.classList.toggle('hidden', isOpen);
        btnAttach.setAttribute('aria-expanded', String(!isOpen));
        if (!isOpen) closeModelSelector();
    };
    document.addEventListener('click', () => {
        balloon.classList.add('hidden');
        btnAttach.setAttribute('aria-expanded', 'false');
    });
    balloon.addEventListener('click', (e) => e.stopPropagation());
}
if (balloon) {

    // Camera button starts hidden (HTML has .hidden class), shown only in native app
    balloon.querySelectorAll('.chat-attach-balloon-item[data-attach="image"]').forEach(btn => {
        (btn as HTMLElement).onclick = (e: MouseEvent) => {
            e.preventDefault();
            e.stopPropagation();
            console.log('[ATTACH] Image button clicked');
            if (imageInput) {
                console.log('[ATTACH] Triggering imageInput.click()');
                imageInput.click();
            } else {
                console.warn('[ATTACH] imageInput not found');
            }
            balloon.classList.add('hidden');
            if (btnAttach) btnAttach.setAttribute('aria-expanded', 'false');
        };
    });
    balloon.querySelectorAll('.chat-attach-balloon-item[data-attach="camera"]').forEach(btn => {
        (btn as HTMLElement).onclick = (e: MouseEvent) => {
            e.preventDefault();
            e.stopPropagation();
            console.log('[ATTACH] Camera button clicked');
            if (cameraInput) {
                console.log('[ATTACH] Triggering cameraInput.click()');
                cameraInput.click();
            } else {
                console.warn('[ATTACH] cameraInput not found');
            }
            balloon.classList.add('hidden');
            if (btnAttach) btnAttach.setAttribute('aria-expanded', 'false');
        };
    });
    balloon.querySelectorAll('.chat-attach-balloon-item[data-attach="document"]').forEach(btn => {
        (btn as HTMLElement).onclick = (e: MouseEvent) => {
            e.preventDefault();
            e.stopPropagation();
            console.log('[ATTACH] Document button clicked');
            if (documentInput) {
                console.log('[ATTACH] Triggering documentInput.click()');
                documentInput.click();
            } else {
                console.warn('[ATTACH] documentInput not found');
            }
            balloon.classList.add('hidden');
            if (btnAttach) btnAttach.setAttribute('aria-expanded', 'false');
        };
    });
}
if (imageInput) {
    imageInput.onchange = () => {
        console.log('[ATTACH] imageInput.onchange fired');

        const file = imageInput.files?.[0];
        console.log('[ATTACH] File:', file?.name, file?.type);
        if (!file || !file.type.startsWith('image/')) return;

        const reader = new FileReader();
        reader.onload = () => { if (typeof reader.result === 'string') addAttachedImage(reader.result); };
        reader.readAsDataURL(file);
        imageInput.value = '';
    };
}
if (cameraInput) {
    cameraInput.onchange = () => {
        console.log('[ATTACH] cameraInput.onchange fired');

        const file = cameraInput.files?.[0];
        console.log('[ATTACH] File:', file?.name, file?.type);
        if (!file || !file.type.startsWith('image/')) return;

        const reader = new FileReader();
        reader.onload = () => { if (typeof reader.result === 'string') addAttachedImage(reader.result); };
        reader.readAsDataURL(file);
        cameraInput.value = '';
    };
}
if (documentInput) {
    documentInput.onchange = async () => {

        const file = documentInput.files?.[0];
        if (!file) return;

        const name = (file.name || '').toLowerCase();

        try {
            if (name.endsWith('.txt')) {

                const text = await file.text();
                addAttachedDocument(text, file.name);
            } else {

                const formData = new FormData();
                formData.append('file', file);

                const token = localStorage.getItem('hyve_token') || authToken;

                const res = await fetch('/api/extract-document', {
                    method: 'POST',
                    headers: { 'Authorization': `Bearer ${token}` },
                    body: formData
                });
                if (!res.ok) {

                    const err = await res.json().catch(() => ({}));
                    throw new Error(err.detail || res.statusText);
                }

                const data = await res.json();
                addAttachedDocument(data.text || '', file.name);
            }

        } catch (err) {
            showToast(_errMsg(err) || t('chat.error_document') || 'Document error', 'error');
        }
        documentInput.value = '';
    };
}

const input = document.getElementById('user-input') as HTMLTextAreaElement | null;
if (input) {
    input.onkeydown = (e) => {

        // Let slash autocomplete handle arrow/tab/enter/esc first
        if (handleSlashKeydown(e)) return;
        if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            sendMessage();
        }
    };
    input.addEventListener('input', () => {
        input.style.height = 'auto';
        input.style.height = Math.min(input.scrollHeight, 160) + 'px';
        handleSlashInput(input.value);
    });

    // Paste image from clipboard (Ctrl+V / Cmd+V with image)
    input.addEventListener('paste', (e) => {

        const items = e.clipboardData?.items;
        if (!items) return;
        for (const item of items) {
            if (item.type.startsWith('image/')) {
                e.preventDefault();

                const blob = item.getAsFile();
                if (!blob) continue;

                const reader = new FileReader();
                reader.onload = () => { const r = reader.result; if (typeof r === 'string') addAttachedImage(r); };
                reader.readAsDataURL(blob);
                return; // only first image
            }
        }
    });
    input.onfocus = () => {
        if (!currentSessionId) newChatSession();
    };
    input.onblur = () => {

        // Nav visibility managed centrally by _onKeyboardChange / __onAndroidKeyboard
    };
}

// Handle virtual keyboard — works both from Android native callback and visualViewport API.

// ── Drag & drop image onto chat area ──────────────────────────

const chatWrapper = document.querySelector('.chat-messages-wrapper') || document.getElementById('chat-container');
if (chatWrapper) {
    chatWrapper.addEventListener('dragover', (e: Event) => { const de = e as DragEvent; de.preventDefault(); if (de.dataTransfer) de.dataTransfer.dropEffect = 'copy'; });
    chatWrapper.addEventListener('drop', (e: Event) => { const de = e as DragEvent;
        de.preventDefault();

        const file = [...(de.dataTransfer?.files || [])].find(f => f.type.startsWith('image/'));
        if (!file) return;

        const reader = new FileReader();
        reader.onload = () => { if (typeof reader.result === 'string') addAttachedImage(reader.result); };
        reader.readAsDataURL(file);
    });
}

const _onKeyboardChange = (kbHeight: number) => {

    const isOpen = kbHeight > 80;

    // Hide bottom nav when keyboard is up

    const nav = document.getElementById('mobile-nav');
    if (nav) nav.style.display = isOpen ? 'none' : '';

    const wrapper = document.querySelector('.chat-messages-wrapper');

    const container = document.getElementById('chat-container');

    const emptyState = document.getElementById('chat-empty-state');
    if (isOpen) {
        if (container && container.children.length > 0) {

            // Chat has messages → scroll last message into view above keyboard
            requestAnimationFrame(() => {
                if (wrapper) wrapper.scrollTop = wrapper.scrollHeight;
            });
        } else {

            // Chat is empty → keep logo centered in the reduced space
            if (emptyState) {
                emptyState.style.paddingBottom = '0';
                emptyState.style.justifyContent = 'center';
            }
        }
    } else {

        // Keyboard closed → restore empty state
        if (emptyState) {
            emptyState.style.paddingBottom = '';
            emptyState.style.justifyContent = '';
        }
    }
};

// Android WebView — called by MainActivity via evaluateJavascript

window.__onAndroidKeyboard = _onKeyboardChange;

// Fallback: visualViewport API for browsers
if (window.visualViewport) {
    let _lastVVHeight = window.visualViewport.height;

    window.visualViewport.addEventListener('resize', () => {

        const vv = window.visualViewport;
        if (!vv) return;

        const delta = _lastVVHeight - vv.height;
        _lastVVHeight = vv.height;
        _onKeyboardChange(delta > 80 ? delta : 0);
    });
}

// 5. Form creare user (admin)

const adminForm = document.getElementById('admin-create-user-form');
if (adminForm) {
    adminForm.onsubmit = async (e) => {
        e.preventDefault();

        const username = _appEl('admin-username')?.value?.trim();

        const password = _appEl('admin-password')?.value || '';

        const fullName = _appEl('admin-full-name')?.value?.trim();
        if (!username || !password) return;

        try {
            await createUser(username, password, fullName || '');

            const u = _appEl('admin-username'); const p = _appEl('admin-password'); const f = _appEl('admin-full-name');
            if (u) u.value = '';
            if (p) p.value = '';
            if (f) f.value = '';
            await loadAdminUsers();
            showToast(t('admin.created'), 'success');

        } catch (err) {
            showToast(_errMsg(err) || t('admin.error_create'), 'error');
        }
    };
}
}
