/**
 * Chat empty-state layout and welcome greetings.
 */

import { apiCall } from '../api.js';
import { tRaw } from '../lang/index.js';

interface GreetingItem {
    text: string;
}

interface AiGreetingsCache {
    enabled?: boolean;
    frequencyHours?: number;
    generatedAt?: number;
    greetings?: GreetingItem[];
}

function greetingItems(key: string): GreetingItem[] {
    const raw = tRaw(key);
    if (!Array.isArray(raw)) return [];
    return raw.filter((item): item is GreetingItem => !!item && typeof item === 'object' && typeof item.text === 'string');
}

function syncChatEmptyLayoutState() {
    const view = document.querySelector('.chat-view');
    const emptyState = document.getElementById('chat-empty-state');
    if (!view || !emptyState) return;
    view.classList.toggle('chat-view-empty', !emptyState.classList.contains('is-hidden'));
}

function applyRandomGreeting(container: HTMLElement) {
    const titleEl = container.querySelector('.chat-empty-title') as HTMLElement | null;
    if (!titleEl) return;

    const general = greetingItems('chat.welcome_greetings');
    const hour = new Date().getHours();
    const todKey = hour >= 5 && hour < 12 ? 'chat.welcome_greetings_morning'
        : hour >= 12 && hour < 18 ? 'chat.welcome_greetings_afternoon'
            : 'chat.welcome_greetings_evening';
    const todPool = greetingItems(todKey);

    let aiPool: GreetingItem[] = [];
    try {
        const cached = JSON.parse(localStorage.getItem('hyve_ai_greetings') || '{}') as AiGreetingsCache;
        if (Array.isArray(cached.greetings) && cached.greetings.length) aiPool = cached.greetings;
    } catch (_) {}

    const pool = [...general, ...todPool, ...aiPool];
    if (!pool.length) return;

    const pick = pool[Math.floor(Math.random() * pool.length)];
    titleEl.textContent = pick.text;
    titleEl.classList.remove('greeting-fade-in');
    void titleEl.offsetWidth;
    titleEl.classList.add('greeting-fade-in');
    titleEl.addEventListener('animationend', () => titleEl.classList.remove('greeting-fade-in'), { once: true });
}

export function hideChatEmptyState() {
    const el = document.getElementById('chat-empty-state');
    if (el) el.classList.add('is-hidden');
    syncChatEmptyLayoutState();
}

export function showChatEmptyState() {
    const el = document.getElementById('chat-empty-state');
    if (el) {
        el.classList.remove('is-hidden');
        applyRandomGreeting(el);
    }
    syncChatEmptyLayoutState();
}

export async function maybeRefreshAiGreetings() {
    try {
        const cached = JSON.parse(localStorage.getItem('hyve_ai_greetings') || '{}') as AiGreetingsCache;
        if (!cached.enabled) return;

        const freqHours = cached.frequencyHours || 24;
        const lastGen = cached.generatedAt || 0;
        const elapsed = (Date.now() - lastGen) / 3600000;
        if (elapsed < freqHours) return;

        const res = await apiCall('/api/welcome-greetings', { method: 'POST' });
        if (!res.ok) return;
        const data = await res.json();
        if (data && Array.isArray(data.greetings) && data.greetings.length) {
            cached.greetings = data.greetings;
            cached.generatedAt = Date.now();
            localStorage.setItem('hyve_ai_greetings', JSON.stringify(cached));
        }
    } catch (_) {}
}

function initEmptyState() {
    syncChatEmptyLayoutState();
    const el = document.getElementById('chat-empty-state');
    if (el && !el.classList.contains('is-hidden')) applyRandomGreeting(el);
}

export function applyInitialGreeting() {
    initEmptyState();
}
