/**
 * YAML editor section for the Hyveview card modal.
 */

import { t } from '../../js/lang/index.js';
import { host } from '../host.js';
import type { HyveviewEditorCard } from '../types/editor.js';

function _label(key: string, fallback: string): string {
  const out = t(key);
  return out !== key ? out : fallback;
}

export interface CardYamlFormSnapshot {
  type: string;
  entity: string | null;
  layout: { col: number; row: number };
  config: Record<string, unknown>;
  visibility: Record<string, unknown> | null;
}

export function renderCardYamlEditor(
  hostEl: HTMLElement,
  _card: HyveviewEditorCard,
): {
  syncFromForm(snapshot: CardYamlFormSnapshot): void;
  reloadFromForm(snapshot: CardYamlFormSnapshot): void;
  read(): { used: boolean; snapshot?: CardYamlFormSnapshot; error?: string };
} {
  let touched = false;
  let text = '';

  hostEl.innerHTML = `
    <p class="hv-editor-hint">${_label('dashboard.interactions.card_yaml_hint', 'Edit this card as YAML. Use “Reload from form” to sync from the visual fields.')}</p>
    <div class="hv-card-yaml-toolbar">
      <button type="button" class="hv-btn-ghost" data-role="yaml-reload">${_label('dashboard.interactions.card_yaml_reload', 'Reload from form')}</button>
      <span class="hv-card-yaml-badge" data-role="yaml-badge"></span>
    </div>
    <textarea class="hv-card-yaml-input" data-role="yaml-input" spellcheck="false" rows="14"></textarea>
  `;

  const input = hostEl.querySelector('[data-role=yaml-input]') as HTMLTextAreaElement;
  const badge = hostEl.querySelector('[data-role=yaml-badge]') as HTMLElement;
  const reloadBtn = hostEl.querySelector('[data-role=yaml-reload]') as HTMLButtonElement;
  let lastSnapshot: CardYamlFormSnapshot | null = null;

  const paintBadge = () => {
    if (!badge) return;
    badge.textContent = touched
      ? _label('dashboard.interactions.card_yaml_edited', 'Edited manually')
      : _label('dashboard.interactions.card_yaml_synced', 'Synced with form');
    badge.dataset.tone = touched ? 'edited' : 'synced';
  };

  const writeYaml = (next: string, nextTouched: boolean) => {
    text = next;
    touched = nextTouched;
    if (input) input.value = next;
    paintBadge();
  };

  const snapshotToYaml = (snapshot: CardYamlFormSnapshot) => {
    if (typeof host.stringifyCardYaml !== 'function') return '';
    return host.stringifyCardYaml(snapshot);
  };

  input?.addEventListener('input', () => {
    text = input.value;
    touched = true;
    paintBadge();
  });

  reloadBtn?.addEventListener('click', () => {
    if (!lastSnapshot) return;
    writeYaml(snapshotToYaml(lastSnapshot), false);
  });

  paintBadge();

  return {
    syncFromForm(snapshot: CardYamlFormSnapshot) {
      lastSnapshot = snapshot;
      if (touched) return;
      writeYaml(snapshotToYaml(snapshot), false);
    },
    reloadFromForm(snapshot: CardYamlFormSnapshot) {
      lastSnapshot = snapshot;
      writeYaml(snapshotToYaml(snapshot), false);
    },
    read() {
      if (!touched) return { used: false };
      if (typeof host.parseCardYaml !== 'function') {
        return {
          used: true,
          error: _label('dashboard.interactions.card_yaml_unavailable', 'YAML parser unavailable'),
        };
      }
      try {
        return { used: true, snapshot: host.parseCardYaml(text) };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return { used: true, error: message };
      }
    },
  };
}
