/**
 * Agent activity timeline and pending-state HTML for streaming bubbles.
 */

import { t } from '../lang/index.js';
import { escapeHtml, TOOL_ICONS } from '../utils.js';

const statusIcons: Record<string, string> = TOOL_ICONS;

interface StatusLine {
    type?: string;
    label?: string;
}

interface TimelineBuildOptions {
    statusLines?: StatusLine[];
    thinkingStarted?: boolean;
    thinkingContent?: string;
    thinkingDurationSec?: number | null;
    generating?: boolean;
    preparing?: boolean;
    streaming?: boolean;
    hasThinkingContent?: boolean;
}

interface TimelineStep {
    icon: string;
    label: string;
    detail?: string;
}

export function buildPendingStateHtml(label: string, icon = '') {
    const safeLabel = escapeHtml(label || 'Se gândește');
    const iconHtml = icon ? `<i class="fas ${icon} chat-pending-icon"></i>` : '';
    return `<div class="chat-pending-state" aria-live="polite">
        <span class="chat-pending-indicator"><span></span><span></span><span></span></span>
        ${iconHtml}<span class="chat-pending-label">${safeLabel}</span>
    </div>`;
}

function normalizeAgentTimelineLabel(statusType: string, label: string) {
    const raw = (label || '').trim();
    const type = (statusType || '').trim();
    if (type === 'search_web') return raw || 'Căutare pe web';
    if (type === 'search_web_images') return raw || 'Căutare imagini';
    if (type === 'read_web_page') return raw || 'Citește pagina';
    if (type === 'cctv_describe') return raw || 'Analizează camera';
    if (type === 'create_skill') return raw || 'Construiește skill-ul';
    if (/^found\s+\d+\s+results?$/i.test(raw)) {
        return raw.replace(/^Found\s+(\d+)\s+results?$/i, '$1 rezultate găsite');
    }
    if (/^search error \(http\)$/i.test(raw)) return 'Eroare la căutare';
    if (/^no results$/i.test(raw)) return 'Niciun rezultat';
    if (/^descărcat pagină:/i.test(raw)) return raw.replace(/^Descărcat pagină:/i, 'Citește pagina:');
    if (/^fetching page/i.test(raw)) return raw.replace(/^Fetching page/i, 'Citește pagina');
    return raw;
}

export function buildTimelineStructureKey({
    statusLines = [],
    thinkingStarted = false,
    thinkingDurationSec = null,
    generating = false,
    preparing = false,
    streaming = false,
    hasThinkingContent = false,
}: TimelineBuildOptions = {}) {
    return JSON.stringify({
        thinkingStarted: !!thinkingStarted,
        thinkingDurationSec,
        generating: !!generating,
        preparing: !!preparing,
        streaming: !!streaming,
        hasThinkingContent: !!hasThinkingContent,
        steps: statusLines.map((s) => ({ type: s.type || '', label: s.label || '' })),
    });
}

export function buildAgentTimelineHtml({
    statusLines = [],
    thinkingStarted = false,
    thinkingContent = '',
    thinkingDurationSec = null,
    generating = false,
    preparing = false,
    streaming = false,
}: TimelineBuildOptions = {}) {
    const steps: TimelineStep[] = [];
    if (thinkingStarted || (thinkingContent && thinkingContent.trim())) {
        steps.push({
            icon: 'fa-brain',
            label: thinkingDurationSec ? `A gândit ${thinkingDurationSec}s` : 'Se gândește',
            detail: thinkingContent || '',
        });
    } else if (preparing && statusLines.length === 0 && !generating) {
        steps.push({ icon: 'fa-comment-dots', label: 'Pregătesc răspunsul' });
    }
    for (const s of statusLines) {
        steps.push({
            icon: statusIcons[s.type ?? ''] || 'fa-circle-dot',
            label: normalizeAgentTimelineLabel(s.type ?? '', s.label || s.type || ''),
        });
    }
    if (generating) {
        steps.push({ icon: 'fa-pen-nib', label: 'Generez răspunsul' });
    }
    if (steps.length === 0) return '';
    const lastIndex = steps.length - 1;

    const itemsHtml = steps.map((step, i) => {
        const isCurrent = streaming && i === lastIndex;
        const stateClass = isCurrent ? ' chat-agent-timeline__item--current' : ' chat-agent-timeline__item--done';
        const node = isCurrent
            ? '<span class="chat-agent-timeline__spinner"></span>'
            : '<i class="fas fa-check chat-agent-timeline__check"></i>';
        const detailText = (step.detail || '').trim();
        const isThinkingStep = step.icon === 'fa-brain';
        const showDetail = isThinkingStep && (detailText || (streaming && isCurrent));
        const isLiveReasoning = streaming && isThinkingStep && isCurrent;
        const detailHtml = showDetail
            ? `<div class="chat-agent-timeline__detail${isLiveReasoning ? ' chat-agent-timeline__detail--streaming' : ''}">
                <div class="chat-agent-timeline__detail-stream">${detailText ? escapeHtml(detailText).replace(/\n/g, '<br>') : ''}</div>
                ${isLiveReasoning ? '<span class="chat-agent-timeline__detail-cursor" aria-hidden="true"></span>' : ''}
            </div>`
            : '';
        return `<div class="chat-agent-timeline__item${stateClass}">
            <span class="chat-agent-timeline__node">${node}</span>
            <i class="fas ${step.icon} chat-agent-timeline__icon"></i>
            <span class="chat-agent-timeline__label">${escapeHtml(step.label)}</span>
            ${detailHtml}
        </div>`;
    }).join('');

    const timeline = `<div class="chat-agent-timeline" aria-live="polite">${itemsHtml}</div>`;

    if (streaming) {
        return `<div class="chat-agent-timeline-wrap chat-agent-timeline-open">${timeline}</div>`;
    }

    const stepWord = steps.length === 1 ? 'pas' : 'pași';
    const summaryLabel = thinkingDurationSec
        ? `A gândit ${thinkingDurationSec}s · ${steps.length} ${stepWord}`
        : `Activitate · ${steps.length} ${stepWord}`;
    const expandLabel = escapeHtml(t('chat.thinking_expand') || 'Arată activitatea');
    return `<div class="chat-agent-timeline-wrap chat-agent-timeline-collapsible">
        <button type="button" class="chat-agent-timeline-summary" aria-expanded="false" aria-label="${expandLabel}">
            <i class="fas fa-list-check chat-agent-timeline-summary__icon"></i>
            <span class="chat-agent-timeline-summary__label">${escapeHtml(summaryLabel)}</span>
            <i class="fas fa-chevron-down chat-agent-timeline-summary__chevron"></i>
        </button>
        <div class="chat-agent-timeline-body">${timeline}</div>
    </div>`;
}
