/**
 * Settings → Backup & restore hub panel.
 */
import { apiCall } from '../api.js';
import { upgradeNativeSelect } from '../features_custom_selects.js';
import { t, translateApiDetail } from '../lang/index.js';
import { showConfirm, escapeHtml, showToast } from '../utils.js';
import { isExplicitNonAdmin } from '../user_context.js';
import { watchServerRestartAndReload } from '../startup_status.js';

interface BackupArchiveRow {
    name: string;
    path: string;
    size: number;
    created_at: string;
    hyve_version: string;
    file_count: number;
    alembic_revision?: string | null;
}

interface BackupRemoteSettings {
    enabled?: boolean;
    provider?: string;
    upload_on_create?: boolean;
    retention_count?: number;
    s3?: { bucket?: string; prefix?: string; region?: string; endpoint_url?: string };
    sftp?: { host?: string; port?: number; username?: string; password?: string; remote_path?: string };
}

interface BackupSettings {
    schedule_interval?: string;
    retention_count?: number;
    pre_restore_retention_count?: number;
    include_optional?: boolean;
    include_frigate_media?: boolean;
    refetch_addons?: boolean;
    encrypt_at_rest?: boolean;
    remote?: BackupRemoteSettings;
    last_scheduled_at?: string | null;
    last_scheduled_status?: string | null;
}

interface BackupStatusResponse {
    maintenance?: boolean;
    maintenance_reason?: string;
    archives?: BackupArchiveRow[];
    settings?: BackupSettings;
    encryption_available?: boolean;
    encryption_key?: BackupEncryptionKeyStatus;
    remote_enabled?: boolean;
    remote_configured?: boolean;
}

interface BackupEncryptionKeyStatus {
    configured?: boolean;
    source?: 'env' | 'file' | null;
    file_path?: string | null;
}

interface BackupRemoteArchiveRow {
    name: string;
    remote_key?: string;
    size: number;
    modified_at?: string | null;
    provider?: string;
}

let _cachedBackupSettings: BackupSettings | undefined;
let _cachedEncryptionKeyStatus: BackupEncryptionKeyStatus | undefined;

function _remoteUiAvailable(): boolean {
    return !!_el('backup-remote-enabled');
}

function _el<T extends HTMLElement>(id: string): T | null {
    return document.getElementById(id) as T | null;
}

function _optionsFromForm(): {
    include_optional: boolean;
    include_frigate_media: boolean;
    refetch_addons: boolean;
} {
    return {
        include_optional: !!_el<HTMLInputElement>('backup-include-optional')?.checked,
        include_frigate_media: !!_el<HTMLInputElement>('backup-include-frigate-media')?.checked,
        refetch_addons: !!_el<HTMLInputElement>('backup-refetch-addons')?.checked,
    };
}

function _formatBytes(size: number): string {
    const n = Number(size) || 0;
    if (n < 1024) return `${n} B`;
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
    if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
    return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

function _formatWhen(iso: string): string {
    const raw = String(iso || '').trim();
    if (!raw) return '—';
    const d = new Date(raw);
    if (Number.isNaN(d.getTime())) return raw;
    return d.toLocaleString();
}

function _setStatus(html: string, kind: 'hidden' | 'info' | 'success' | 'warning' | 'error' = 'info'): void {
    const box = _el('backup-status');
    if (!box) return;
    if (kind === 'hidden' || !html) {
        box.classList.add('hidden');
        box.innerHTML = '';
        return;
    }
    const styles: Record<string, string> = {
        info: 'border-cyan-500/20 bg-cyan-500/5 text-cyan-100',
        success: 'border-emerald-500/20 bg-emerald-500/5 text-emerald-100',
        warning: 'border-amber-500/20 bg-amber-500/5 text-amber-100',
        error: 'border-red-500/20 bg-red-500/5 text-red-100',
    };
    box.className = `text-[11px] rounded-xl p-3 border ${styles[kind] || styles.info}`;
    box.innerHTML = html;
    box.classList.remove('hidden');
}

function _setMaintenanceBanner(active: boolean, reason = ''): void {
    const banner = _el('backup-maintenance-banner');
    if (!banner) return;
    if (!active) {
        banner.classList.add('hidden');
        banner.innerHTML = '';
        return;
    }
    banner.className =
        'text-[11px] rounded-xl p-3 border border-amber-500/25 bg-amber-500/10 text-amber-100';
    banner.innerHTML = `<i class="fas fa-screwdriver-wrench mr-1.5"></i>${escapeHtml(
        reason ? `${t('backup.maintenance_active')} (${reason})` : t('backup.maintenance_active'),
    )}`;
    banner.classList.remove('hidden');
}

function _toggleRemoteArchivesSection(show: boolean): void {
    _el('backup-remote-archives-section')?.classList.toggle('hidden', !show);
}

function _remoteArchiveRowHtml(row: BackupRemoteArchiveRow): string {
    const meta = [
        _formatWhen(row.modified_at || ''),
        _formatBytes(row.size),
        row.provider ? String(row.provider).toUpperCase() : '',
    ]
        .filter(Boolean)
        .join(' · ');
    return `<div class="upd-row">
        <div class="upd-row-main min-w-0">
            <span class="upd-row-icon inline-flex items-center justify-center flex-shrink-0"><i class="fas fa-cloud text-sky-400"></i></span>
            <span class="min-w-0">
                <span class="upd-row-name block truncate">${escapeHtml(row.name)}</span>
                <span class="text-[10px] text-slate-500 block truncate">${meta}</span>
            </span>
        </div>
        <div class="upd-row-status flex items-center gap-1">
            <button type="button" data-config-action="pullRemoteBackup" data-config-name="${escapeHtml(row.name)}" class="upd-row-btn" title="${escapeHtml(t('backup.remote_pull_btn'))}"><i class="fas fa-download"></i></button>
            <button type="button" data-config-action="restoreRemoteBackup" data-config-name="${escapeHtml(row.name)}" class="upd-row-btn" title="${escapeHtml(t('backup.remote_restore_btn'))}"><i class="fas fa-clock-rotate-left"></i></button>
        </div>
    </div>`;
}

function _renderRemoteArchives(archives: BackupRemoteArchiveRow[]): void {
    const list = _el('backup-remote-list');
    if (!list) return;
    if (!archives.length) {
        list.innerHTML = `<div class="text-center py-8 text-slate-500 text-xs">${escapeHtml(t('backup.no_remote_archives'))}</div>`;
        return;
    }
    list.innerHTML = archives.map(_remoteArchiveRowHtml).join('');
}

export async function loadRemoteBackupArchives(): Promise<void> {
    if (!_remoteUiAvailable()) return;
    const list = _el('backup-remote-list');
    if (list) {
        list.innerHTML = `<div class="text-center py-6 text-slate-500 text-xs"><i class="fas fa-spinner fa-spin mr-2"></i>${escapeHtml(t('backup.remote_loading'))}</div>`;
    }
    try {
        const res = await apiCall('/api/backup/remote/archives');
        const data = (await res.json().catch(() => ({}))) as {
            detail?: unknown;
            archives?: BackupRemoteArchiveRow[];
        };
        if (!res.ok) throw new Error(translateApiDetail(data.detail) || t('backup.failed'));
        _renderRemoteArchives(data.archives || []);
    } catch (e) {
        if (list) list.innerHTML = '';
        _setStatus(
            `<i class="fas fa-triangle-exclamation mr-1.5"></i>${escapeHtml(e instanceof Error ? e.message : String(e))}`,
            'error',
        );
    }
}

async function _fetchEncryptionKey(): Promise<{ source: string; key: string }> {
    const res = await apiCall('/api/backup/encryption-key');
    const data = (await res.json().catch(() => ({}))) as { detail?: unknown; source?: string; key?: string };
    if (!res.ok) throw new Error(translateApiDetail(data.detail) || t('backup.failed'));
    const key = String(data.key || '').trim();
    if (!key) throw new Error(t('backup.encryption_key_missing'));
    return { source: String(data.source || 'file'), key };
}

function _downloadKeyFile(key: string): void {
    const blob = new Blob([key], { type: 'application/octet-stream' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'backup_archive.key';
    a.click();
    URL.revokeObjectURL(url);
}

function _updateEncryptionKeySection(
    settings?: BackupSettings,
    keyStatus?: BackupEncryptionKeyStatus,
): void {
    const section = _el('backup-encryption-key-section');
    const statusEl = _el('backup-encryption-key-status');
    const showBtn = _el<HTMLButtonElement>('backup-show-key-btn');
    const dlBtn = _el<HTMLButtonElement>('backup-download-key-btn');
    if (!section) return;
    const wantsEncrypt = !!settings?.encrypt_at_rest;
    const configured = !!keyStatus?.configured;
    section.classList.toggle('hidden', !(wantsEncrypt || configured));
    if (wantsEncrypt || configured) {
        if (statusEl) {
            statusEl.textContent = configured
                ? t(
                    keyStatus?.source === 'env'
                        ? 'backup.encryption_key_source_env'
                        : 'backup.encryption_key_source_file',
                    { path: keyStatus?.file_path || 'secrets/backup_archive.key' },
                )
                : t('backup.encryption_key_pending');
        }
        if (showBtn) showBtn.disabled = !configured;
        if (dlBtn) dlBtn.disabled = !configured;
    }
}

function _showEncryptionKeyModal(key: string, source: string): void {
    let modal = document.getElementById('backup-encryption-key-modal');
    if (!modal) {
        modal = document.createElement('div');
        modal.id = 'backup-encryption-key-modal';
        modal.className = 'modal-overlay app-modal fixed inset-0 z-[80] hidden flex items-center justify-center p-2 sm:p-4';
        modal.innerHTML = `
            <div class="glass app-modal-panel app-modal-content max-w-lg w-full">
                <div class="app-modal-header">
                    <div class="min-w-0">
                        <h3 class="text-sm font-bold text-accent uppercase tracking-widest flex items-center gap-2">
                            <i class="fas fa-key"></i><span id="backup-encryption-key-modal-title"></span>
                        </h3>
                        <p id="backup-encryption-key-modal-subtitle" class="app-modal-subtitle"></p>
                    </div>
                    <button type="button" class="app-modal-close" data-config-action="closeBackupEncryptionKeyModal" aria-label="Close">
                        <i class="fas fa-xmark"></i>
                    </button>
                </div>
                <div class="app-modal-body space-y-3">
                    <p id="backup-encryption-key-modal-warning" class="text-[11px] text-amber-200/90 leading-relaxed"></p>
                    <input type="text" id="backup-encryption-key-modal-input" readonly
                        class="w-full bg-slate-900 border border-theme-subtle rounded-xl p-3 text-xs mono text-slate-200 select-all" />
                </div>
                <div class="app-modal-footer justify-end gap-2">
                    <button type="button" data-config-action="copyBackupEncryptionKey" id="backup-encryption-key-copy-btn" class="hy-btn hy-btn-ghost text-[11px]"></button>
                    <button type="button" data-config-action="downloadBackupEncryptionKeyFromModal" id="backup-encryption-key-modal-download-btn" class="hy-btn hy-btn-primary text-[11px]"></button>
                </div>
            </div>`;
        document.body.appendChild(modal);
        modal.addEventListener('click', (e) => {
            if (e.target === modal) hideBackupEncryptionKeyModal();
        });
        modal.querySelector('.app-modal-panel')?.addEventListener('click', (e) => e.stopPropagation());
        modal.querySelector('[data-config-action="closeBackupEncryptionKeyModal"]')?.addEventListener('click', (e) => {
            e.preventDefault();
            hideBackupEncryptionKeyModal();
        });
    }

    const title = modal.querySelector('#backup-encryption-key-modal-title');
    const subtitle = modal.querySelector('#backup-encryption-key-modal-subtitle');
    const warning = modal.querySelector('#backup-encryption-key-modal-warning');
    const input = modal.querySelector('#backup-encryption-key-modal-input') as HTMLInputElement | null;
    const copyBtn = modal.querySelector('#backup-encryption-key-copy-btn');
    const dlBtn = modal.querySelector('#backup-encryption-key-modal-download-btn');

    if (title) title.textContent = t('backup.encryption_key_modal_title');
    if (subtitle) {
        subtitle.textContent = source === 'env'
            ? t('backup.encryption_key_source_env')
            : t('backup.encryption_key_source_file', { path: 'secrets/backup_archive.key' });
    }
    if (warning) warning.textContent = t('backup.encryption_key_modal_warning');
    if (input) input.value = key;
    if (copyBtn) copyBtn.innerHTML = `<i class="fas fa-copy"></i><span>${escapeHtml(t('backup.copy_encryption_key'))}</span>`;
    if (dlBtn) dlBtn.innerHTML = `<i class="fas fa-download"></i><span>${escapeHtml(t('backup.download_encryption_key'))}</span>`;
    modal.dataset.backupKey = key;
    modal.classList.remove('hidden');
    input?.focus();
    input?.select();
}

export function hideBackupEncryptionKeyModal(): void {
    document.getElementById('backup-encryption-key-modal')?.classList.add('hidden');
}

export async function showBackupEncryptionKey(): Promise<void> {
    if (!(await showConfirm(t('backup.encryption_key_confirm')))) return;
    _setStatus(`<i class="fas fa-spinner fa-spin mr-1.5"></i>${escapeHtml(t('backup.encryption_key_loading'))}`, 'info');
    try {
        const data = await _fetchEncryptionKey();
        _setStatus('', 'hidden');
        _showEncryptionKeyModal(data.key, data.source);
    } catch (e) {
        _setStatus(
            `<i class="fas fa-triangle-exclamation mr-1.5"></i>${escapeHtml(e instanceof Error ? e.message : String(e))}`,
            'error',
        );
    }
}

export function downloadBackupEncryptionKeyFromModal(): void {
    const modal = document.getElementById('backup-encryption-key-modal');
    const key = modal?.dataset.backupKey || '';
    if (!key) return;
    _downloadKeyFile(key);
    _setStatus(`<i class="fas fa-circle-check mr-1.5"></i>${escapeHtml(t('backup.encryption_key_downloaded'))}`, 'success');
}

export async function downloadBackupEncryptionKey(): Promise<void> {
    if (!(await showConfirm(t('backup.encryption_key_confirm')))) return;
    try {
        const data = await _fetchEncryptionKey();
        _downloadKeyFile(data.key);
        _setStatus(`<i class="fas fa-circle-check mr-1.5"></i>${escapeHtml(t('backup.encryption_key_downloaded'))}`, 'success');
    } catch (e) {
        _setStatus(
            `<i class="fas fa-triangle-exclamation mr-1.5"></i>${escapeHtml(e instanceof Error ? e.message : String(e))}`,
            'error',
        );
    }
}

export async function copyBackupEncryptionKey(): Promise<void> {
    const modal = document.getElementById('backup-encryption-key-modal');
    const key = modal?.dataset.backupKey || '';
    if (!key) return;
    try {
        await navigator.clipboard.writeText(key);
        _setStatus(`<i class="fas fa-circle-check mr-1.5"></i>${escapeHtml(t('backup.encryption_key_copied'))}`, 'success');
    } catch {
        const input = modal?.querySelector('#backup-encryption-key-modal-input') as HTMLInputElement | null;
        input?.select();
        document.execCommand('copy');
        _setStatus(`<i class="fas fa-circle-check mr-1.5"></i>${escapeHtml(t('backup.encryption_key_copied'))}`, 'success');
    }
}

function _isEncryptedPath(path: string): boolean {
    return String(path || '').endsWith('.enc');
}

function _promptDecryptionKey(): Promise<string | null> {
    return new Promise((resolve) => {
        let modal = document.getElementById('backup-decrypt-key-modal');
        if (!modal) {
            modal = document.createElement('div');
            modal.id = 'backup-decrypt-key-modal';
            modal.className = 'modal-overlay app-modal fixed inset-0 z-[80] hidden flex items-center justify-center p-2 sm:p-4';
            modal.innerHTML = `
                <div class="glass app-modal-panel app-modal-content max-w-md w-full">
                    <div class="app-modal-header">
                        <h3 class="text-sm font-bold text-accent uppercase tracking-widest flex items-center gap-2">
                            <i class="fas fa-lock"></i><span id="backup-decrypt-key-title"></span>
                        </h3>
                        <p id="backup-decrypt-key-prompt" class="app-modal-subtitle"></p>
                    </div>
                    <div class="app-modal-body space-y-3">
                        <p id="backup-decrypt-key-hint" class="text-[11px] text-slate-500 leading-relaxed"></p>
                        <input type="password" id="backup-decrypt-key-input" autocomplete="off"
                            class="w-full bg-slate-900 border border-theme-subtle rounded-xl p-3 text-sm mono text-slate-200 focus:border-accent outline-none" />
                    </div>
                    <div class="app-modal-footer justify-end gap-2">
                        <button type="button" id="backup-decrypt-key-cancel" class="px-4 py-2 rounded-xl text-sm font-bold text-slate-400 hover:bg-white/5 transition-colors"></button>
                        <button type="button" id="backup-decrypt-key-skip" class="px-4 py-2 rounded-xl text-sm font-bold text-slate-300 hover:bg-white/5 transition-colors"></button>
                        <button type="button" id="backup-decrypt-key-ok" class="px-4 py-2 rounded-xl text-sm font-bold text-white bg-accent hover:bg-accent-hover transition-colors"></button>
                    </div>
                </div>`;
            document.body.appendChild(modal);
            modal.addEventListener('click', (e) => {
                if (e.target === modal) resolve(null);
            });
            modal.querySelector('.app-modal-panel')?.addEventListener('click', (e) => e.stopPropagation());
        }

        const title = modal.querySelector('#backup-decrypt-key-title');
        const prompt = modal.querySelector('#backup-decrypt-key-prompt');
        const hint = modal.querySelector('#backup-decrypt-key-hint');
        const input = modal.querySelector('#backup-decrypt-key-input') as HTMLInputElement | null;
        const cancelBtn = modal.querySelector('#backup-decrypt-key-cancel') as HTMLButtonElement | null;
        const skipBtn = modal.querySelector('#backup-decrypt-key-skip') as HTMLButtonElement | null;
        const okBtn = modal.querySelector('#backup-decrypt-key-ok') as HTMLButtonElement | null;

        if (title) title.textContent = t('backup.decrypt_key_title');
        if (prompt) prompt.textContent = t('backup.decrypt_key_prompt');
        if (hint) hint.textContent = t('backup.decrypt_key_hint');
        if (input) {
            input.value = '';
            input.placeholder = t('backup.decrypt_key_placeholder');
        }
        if (cancelBtn) cancelBtn.textContent = t('common.cancel');
        if (skipBtn) skipBtn.textContent = t('backup.decrypt_key_skip');
        if (okBtn) okBtn.textContent = t('backup.decrypt_key_continue');

        const close = (value: string | null) => {
            modal?.classList.add('hidden');
            resolve(value);
        };

        cancelBtn?.replaceWith(cancelBtn.cloneNode(true));
        skipBtn?.replaceWith(skipBtn.cloneNode(true));
        okBtn?.replaceWith(okBtn.cloneNode(true));
        const newCancel = modal.querySelector('#backup-decrypt-key-cancel') as HTMLButtonElement | null;
        const newSkip = modal.querySelector('#backup-decrypt-key-skip') as HTMLButtonElement | null;
        const newOk = modal.querySelector('#backup-decrypt-key-ok') as HTMLButtonElement | null;
        newCancel?.addEventListener('click', () => close(null));
        newSkip?.addEventListener('click', () => close(''));
        newOk?.addEventListener('click', () => close(input?.value.trim() || ''));
        input?.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') {
                e.preventDefault();
                close(input.value.trim() || '');
            }
        });

        modal.classList.remove('hidden');
        input?.focus();
    });
}

async function _decryptionKeyForPath(path: string): Promise<string | null | undefined> {
    if (!_isEncryptedPath(path)) return undefined;
    const key = await _promptDecryptionKey();
    if (key === null) return null;
    return key || undefined;
}

function _archiveRowHtml(row: BackupArchiveRow): string {
    const isPreRestore = row.name.startsWith('pre-restore');
    const isEncrypted = row.name.endsWith('.enc');
    const badge = isPreRestore
        ? `<span class="upd-badge upd-badge--warn"><i class="fas fa-shield-halved"></i>${escapeHtml(t('backup.badge_safety'))}</span>`
        : isEncrypted
            ? `<span class="upd-badge upd-badge--warn"><i class="fas fa-lock"></i>${escapeHtml(t('backup.badge_encrypted'))}</span>`
            : `<span class="upd-badge upd-badge--ok"><i class="fas fa-box-archive"></i>${escapeHtml(t('backup.badge_archive'))}</span>`;

    const meta = [
        _formatWhen(row.created_at),
        _formatBytes(row.size),
        `${row.file_count} ${t('backup.files_label')}`,
        row.hyve_version ? `Hyve ${escapeHtml(row.hyve_version)}` : '',
    ]
        .filter(Boolean)
        .join(' · ');

    const restoreBtn = isPreRestore
        ? `<button type="button" data-config-action="rollbackBackup" data-config-path="${escapeHtml(row.path)}" class="upd-row-btn" title="${escapeHtml(t('backup.rollback_btn'))}"><i class="fas fa-rotate-left"></i></button>`
        : `<button type="button" data-config-action="restoreBackup" data-config-path="${escapeHtml(row.path)}" class="upd-row-btn" title="${escapeHtml(t('backup.restore_btn'))}"><i class="fas fa-clock-rotate-left"></i></button>`;

    return `<div class="upd-row">
        <div class="upd-row-main min-w-0">
            <span class="upd-row-icon inline-flex items-center justify-center flex-shrink-0"><i class="fas fa-database text-teal-400"></i></span>
            <span class="min-w-0">
                <span class="upd-row-name block truncate">${escapeHtml(row.name)}</span>
                <span class="text-[10px] text-slate-500 block truncate">${meta}</span>
            </span>
        </div>
        <div class="upd-row-status flex items-center gap-1">${badge}
            <button type="button" data-config-action="downloadBackupArchive" data-config-path="${escapeHtml(row.path)}" class="upd-row-btn" title="${escapeHtml(t('backup.download_btn'))}"><i class="fas fa-download"></i></button>
            <button type="button" data-config-action="verifyBackup" data-config-path="${escapeHtml(row.path)}" class="upd-row-btn" title="${escapeHtml(t('backup.verify_btn'))}"><i class="fas fa-circle-check"></i></button>
            ${restoreBtn}
            <button type="button" data-config-action="deleteBackupArchive" data-config-path="${escapeHtml(row.path)}" class="upd-row-btn" title="${escapeHtml(t('backup.delete_btn'))}"><i class="fas fa-trash-alt"></i></button>
        </div>
    </div>`;
}

function _applySettings(settings: BackupSettings | undefined): void {
    if (!settings) return;
    const interval = settings.schedule_interval || 'never';
    setBackupScheduleInterval(interval);
    const retention = _el<HTMLInputElement>('backup_retention_count');
    if (retention && settings.retention_count != null) retention.value = String(settings.retention_count);
    const pre = _el<HTMLInputElement>('backup_pre_restore_retention_count');
    if (pre && settings.pre_restore_retention_count != null) {
        pre.value = String(settings.pre_restore_retention_count);
    }
    const opt = _el<HTMLInputElement>('backup-include-optional');
    if (opt) opt.checked = !!settings.include_optional;
    const frigate = _el<HTMLInputElement>('backup-include-frigate-media');
    if (frigate) frigate.checked = !!settings.include_frigate_media;
    const refetch = _el<HTMLInputElement>('backup-refetch-addons');
    if (refetch) refetch.checked = settings.refetch_addons !== false;
    const encrypt = _el<HTMLInputElement>('backup-encrypt-at-rest');
    if (encrypt) encrypt.checked = !!settings.encrypt_at_rest;

    if (!_remoteUiAvailable()) {
        const last = _el('backup-last-scheduled');
        if (last) {
            if (settings.last_scheduled_at) {
                const status = settings.last_scheduled_status === 'failed'
                    ? t('backup.last_scheduled_failed')
                    : t('backup.last_scheduled_ok');
                last.textContent = t('backup.last_scheduled', {
                    when: _formatWhen(settings.last_scheduled_at),
                    status,
                });
            } else {
                last.textContent = t('backup.last_scheduled_never');
            }
        }
        return;
    }

    const remote = settings.remote || {};
    const remoteEnabled = _el<HTMLInputElement>('backup-remote-enabled');
    if (remoteEnabled) remoteEnabled.checked = !!remote.enabled;
    const provider = _el<HTMLSelectElement>('backup_remote_provider');
    if (provider) provider.value = remote.provider || 'none';
    _toggleRemoteFields(provider?.value || 'none');
    const remoteRetention = _el<HTMLInputElement>('backup_remote_retention');
    if (remoteRetention && remote.retention_count != null) {
        remoteRetention.value = String(remote.retention_count);
    }
    const s3 = remote.s3 || {};
    if (_el<HTMLInputElement>('backup_s3_bucket')) _el<HTMLInputElement>('backup_s3_bucket')!.value = s3.bucket || '';
    if (_el<HTMLInputElement>('backup_s3_prefix')) _el<HTMLInputElement>('backup_s3_prefix')!.value = s3.prefix || 'hyve/';
    if (_el<HTMLInputElement>('backup_s3_region')) _el<HTMLInputElement>('backup_s3_region')!.value = s3.region || '';
    if (_el<HTMLInputElement>('backup_s3_endpoint')) _el<HTMLInputElement>('backup_s3_endpoint')!.value = s3.endpoint_url || '';
    const sftp = remote.sftp || {};
    if (_el<HTMLInputElement>('backup_sftp_host')) _el<HTMLInputElement>('backup_sftp_host')!.value = sftp.host || '';
    if (_el<HTMLInputElement>('backup_sftp_port')) _el<HTMLInputElement>('backup_sftp_port')!.value = String(sftp.port || 22);
    if (_el<HTMLInputElement>('backup_sftp_username')) _el<HTMLInputElement>('backup_sftp_username')!.value = sftp.username || '';
    if (_el<HTMLInputElement>('backup_sftp_password') && sftp.password) {
        _el<HTMLInputElement>('backup_sftp_password')!.value = sftp.password;
    }
    if (_el<HTMLInputElement>('backup_sftp_path')) _el<HTMLInputElement>('backup_sftp_path')!.value = sftp.remote_path || '/backups/hyve';

    const last = _el('backup-last-scheduled');
    if (last) {
        if (settings.last_scheduled_at) {
            const status = settings.last_scheduled_status === 'failed'
                ? t('backup.last_scheduled_failed')
                : t('backup.last_scheduled_ok');
            last.textContent = t('backup.last_scheduled', {
                when: _formatWhen(settings.last_scheduled_at),
                status,
            });
        } else {
            last.textContent = t('backup.last_scheduled_never');
        }
    }
}

function _toggleRemoteFields(provider: string): void {
    if (!_remoteUiAvailable()) return;
    _el('backup-remote-s3-fields')?.classList.toggle('hidden', provider !== 's3');
    _el('backup-remote-sftp-fields')?.classList.toggle('hidden', provider !== 'sftp');
}

function _remoteSettingsFromForm(): BackupRemoteSettings {
    const provider = _el<HTMLSelectElement>('backup_remote_provider')?.value || 'none';
    return {
        enabled: !!_el<HTMLInputElement>('backup-remote-enabled')?.checked,
        provider,
        upload_on_create: true,
        retention_count: Math.max(0, parseInt(_el<HTMLInputElement>('backup_remote_retention')?.value || '5', 10) || 0),
        s3: {
            bucket: _el<HTMLInputElement>('backup_s3_bucket')?.value || '',
            prefix: _el<HTMLInputElement>('backup_s3_prefix')?.value || 'hyve/',
            region: _el<HTMLInputElement>('backup_s3_region')?.value || '',
            endpoint_url: _el<HTMLInputElement>('backup_s3_endpoint')?.value || '',
        },
        sftp: {
            host: _el<HTMLInputElement>('backup_sftp_host')?.value || '',
            port: parseInt(_el<HTMLInputElement>('backup_sftp_port')?.value || '22', 10) || 22,
            username: _el<HTMLInputElement>('backup_sftp_username')?.value || '',
            password: _el<HTMLInputElement>('backup_sftp_password')?.value || '',
            remote_path: _el<HTMLInputElement>('backup_sftp_path')?.value || '/backups/hyve',
        },
    };
}

function _settingsFromForm(): BackupSettings {
    const settings: BackupSettings = {
        schedule_interval: _el<HTMLInputElement>('backup_schedule_interval')?.value || 'never',
        retention_count: Math.max(1, parseInt(_el<HTMLInputElement>('backup_retention_count')?.value || '10', 10) || 10),
        pre_restore_retention_count: Math.max(
            1,
            parseInt(_el<HTMLInputElement>('backup_pre_restore_retention_count')?.value || '3', 10) || 3,
        ),
        include_optional: !!_el<HTMLInputElement>('backup-include-optional')?.checked,
        include_frigate_media: !!_el<HTMLInputElement>('backup-include-frigate-media')?.checked,
        refetch_addons: !!_el<HTMLInputElement>('backup-refetch-addons')?.checked,
        encrypt_at_rest: !!_el<HTMLInputElement>('backup-encrypt-at-rest')?.checked,
    };
    if (_remoteUiAvailable()) {
        settings.remote = _remoteSettingsFromForm();
    } else if (_cachedBackupSettings?.remote) {
        settings.remote = _cachedBackupSettings.remote;
    }
    return settings;
}

function _renderArchives(archives: BackupArchiveRow[]): void {
    const list = _el('backup-list');
    const count = _el('backup-count');
    if (count) count.textContent = t('backup.archives_count', { count: archives.length });
    if (!list) return;
    if (!archives.length) {
        list.innerHTML = `<div class="text-center py-10 text-slate-500 text-xs">${escapeHtml(t('backup.no_archives'))}</div>`;
        return;
    }
    list.innerHTML = archives.map(_archiveRowHtml).join('');
}

export async function loadBackupPanel(): Promise<void> {
    if (isExplicitNonAdmin()) return;
    _setStatus('', 'hidden');
    const list = _el('backup-list');
    if (list) {
        list.innerHTML = `<div class="text-center py-8 text-slate-500 text-xs"><i class="fas fa-spinner fa-spin mr-2"></i>${escapeHtml(t('backup.loading'))}</div>`;
    }
    try {
        const res = await apiCall('/api/backup/status');
        if (!res.ok) {
            const err = (await res.json().catch(() => ({}))) as { detail?: unknown };
            throw new Error(translateApiDetail(err.detail) || res.statusText || t('common.error'));
        }
        const data = (await res.json()) as BackupStatusResponse;
        _cachedBackupSettings = data.settings;
        _cachedEncryptionKeyStatus = data.encryption_key;
        _setMaintenanceBanner(!!data.maintenance, data.maintenance_reason || '');
        _applySettings(data.settings);
        _updateEncryptionKeySection(data.settings, data.encryption_key);
        _renderArchives(data.archives || []);
        const showRemote = _remoteUiAvailable() && !!(data.remote_enabled && data.remote_configured);
        _toggleRemoteArchivesSection(showRemote);
        if (showRemote) await loadRemoteBackupArchives();
    } catch (e) {
        _setStatus(
            `<i class="fas fa-triangle-exclamation mr-1.5"></i>${escapeHtml(e instanceof Error ? e.message : String(e))}`,
            'error',
        );
        if (list) list.innerHTML = '';
    }
}

export async function createBackup(): Promise<void> {
    const btn = _el<HTMLButtonElement>('backup-create-btn');
    if (btn) {
        btn.disabled = true;
        btn.innerHTML = `<i class="fas fa-spinner fa-spin"></i><span>${escapeHtml(t('backup.creating'))}</span>`;
    }
    _setStatus(`<i class="fas fa-spinner fa-spin mr-1.5"></i>${escapeHtml(t('backup.creating'))}`, 'info');
    try {
        const res = await apiCall('/api/backup/create', {
            method: 'POST',
            body: _optionsFromForm(),
        });
        const data = (await res.json().catch(() => ({}))) as {
            detail?: unknown;
            path?: string;
            files?: number;
        };
        if (!res.ok) {
            throw new Error(translateApiDetail(data.detail) || t('backup.failed'));
        }
        _setStatus(
            `<i class="fas fa-circle-check mr-1.5"></i>${escapeHtml(t('backup.create_ok', { files: data.files || 0 }))}`,
            'success',
        );
        await loadBackupPanel();
    } catch (e) {
        _setStatus(
            `<i class="fas fa-triangle-exclamation mr-1.5"></i>${escapeHtml(e instanceof Error ? e.message : String(e))}`,
            'error',
        );
    } finally {
        if (btn) {
            btn.disabled = false;
            btn.innerHTML = `<i class="fas fa-plus"></i><span>${escapeHtml(t('backup.create_btn'))}</span>`;
        }
    }
}

export async function verifyBackup(path: string): Promise<void> {
    if (!path) return;
    const decryptionKey = await _decryptionKeyForPath(path);
    if (decryptionKey === null) return;
    _setStatus(`<i class="fas fa-spinner fa-spin mr-1.5"></i>${escapeHtml(t('backup.verifying'))}`, 'info');
    try {
        const res = await apiCall('/api/backup/verify', {
            method: 'POST',
            body: { path, decryption_key: decryptionKey },
        });
        const data = (await res.json().catch(() => ({}))) as { detail?: unknown; files?: number };
        if (!res.ok) throw new Error(translateApiDetail(data.detail) || t('backup.failed'));
        _setStatus(
            `<i class="fas fa-circle-check mr-1.5"></i>${escapeHtml(t('backup.verify_ok', { files: data.files || 0 }))}`,
            'success',
        );
    } catch (e) {
        _setStatus(
            `<i class="fas fa-triangle-exclamation mr-1.5"></i>${escapeHtml(e instanceof Error ? e.message : String(e))}`,
            'error',
        );
    }
}

function _handleRestoreSuccess(data: {
    restored_files?: number;
    pre_restore_backup?: string | null;
    restarting?: boolean;
}): void {
    let msg = t('backup.restore_ok', { files: data.restored_files || 0 });
    if (data.pre_restore_backup) msg += ` ${t('backup.pre_restore_created')}`;
    if (data.restarting) {
        showToast(t('backup.restore_restarting'), 'info', 8000);
        watchServerRestartAndReload();
        msg += ` ${t('backup.restore_restarting')}`;
    }
    _setStatus(`<i class="fas fa-circle-check mr-1.5"></i>${escapeHtml(msg)}`, 'success');
}

async function _afterRestoreComplete(restarting?: boolean): Promise<void> {
    if (!restarting) await loadBackupPanel();
}

export async function restoreBackup(path: string): Promise<void> {
    if (!path) return;
    if (!(await showConfirm(t('backup.confirm_restore')))) return;
    const decryptionKey = await _decryptionKeyForPath(path);
    if (decryptionKey === null) return;
    _setStatus(`<i class="fas fa-spinner fa-spin mr-1.5"></i>${escapeHtml(t('backup.restoring'))}`, 'info');
    try {
        const opts = _optionsFromForm();
        const res = await apiCall('/api/backup/restore', {
            method: 'POST',
            body: {
                path,
                include_optional: opts.include_optional,
                include_frigate_media: opts.include_frigate_media,
                refetch_addons: opts.refetch_addons,
                auto_pre_backup: true,
                decryption_key: decryptionKey,
            },
        });
        const data = (await res.json().catch(() => ({}))) as {
            detail?: unknown;
            restored_files?: number;
            pre_restore_backup?: string | null;
            restarting?: boolean;
        };
        if (!res.ok) throw new Error(translateApiDetail(data.detail) || t('backup.failed'));
        _handleRestoreSuccess(data);
        await _afterRestoreComplete(data.restarting);
    } catch (e) {
        _setStatus(
            `<i class="fas fa-triangle-exclamation mr-1.5"></i>${escapeHtml(e instanceof Error ? e.message : String(e))}`,
            'error',
        );
    }
}

export async function rollbackBackup(path: string): Promise<void> {
    if (!path) return;
    if (!(await showConfirm(t('backup.confirm_rollback')))) return;
    const decryptionKey = await _decryptionKeyForPath(path);
    if (decryptionKey === null) return;
    _setStatus(`<i class="fas fa-spinner fa-spin mr-1.5"></i>${escapeHtml(t('backup.rollbacking'))}`, 'info');
    try {
        const res = await apiCall('/api/backup/rollback', {
            method: 'POST',
            body: { path, decryption_key: decryptionKey },
        });
        const data = (await res.json().catch(() => ({}))) as {
            detail?: unknown;
            restored_files?: number;
            restarting?: boolean;
        };
        if (!res.ok) throw new Error(translateApiDetail(data.detail) || t('backup.failed'));
        let msg = t('backup.rollback_ok', { files: data.restored_files || 0 });
        if (data.restarting) {
            showToast(t('backup.restore_restarting'), 'info', 8000);
            watchServerRestartAndReload();
            msg += ` ${t('backup.restore_restarting')}`;
        }
        _setStatus(`<i class="fas fa-circle-check mr-1.5"></i>${escapeHtml(msg)}`, 'success');
        if (!data.restarting) await loadBackupPanel();
    } catch (e) {
        _setStatus(
            `<i class="fas fa-triangle-exclamation mr-1.5"></i>${escapeHtml(e instanceof Error ? e.message : String(e))}`,
            'error',
        );
    }
}

export async function saveBackupSettings(): Promise<void> {
    const btn = _el<HTMLButtonElement>('backup-save-settings-btn');
    if (btn) {
        btn.disabled = true;
        btn.innerHTML = `<i class="fas fa-spinner fa-spin"></i><span>${escapeHtml(t('backup.saving'))}</span>`;
    }
    try {
        const res = await apiCall('/api/backup/settings', {
            method: 'POST',
            body: _settingsFromForm() as Record<string, unknown>,
        });
        const data = (await res.json().catch(() => ({}))) as BackupSettings & { detail?: unknown };
        if (!res.ok) throw new Error(translateApiDetail(data.detail) || t('backup.failed'));
        _cachedBackupSettings = data;
        _setStatus(`<i class="fas fa-circle-check mr-1.5"></i>${escapeHtml(t('backup.settings_saved'))}`, 'success');
        _applySettings(data);
    } catch (e) {
        _setStatus(
            `<i class="fas fa-triangle-exclamation mr-1.5"></i>${escapeHtml(e instanceof Error ? e.message : String(e))}`,
            'error',
        );
    } finally {
        if (btn) {
            btn.disabled = false;
            btn.innerHTML = `<i class="fas fa-check"></i><span>${escapeHtml(t('backup.save_settings'))}</span>`;
        }
    }
}

export async function deleteBackupArchive(path: string): Promise<void> {
    if (!path) return;
    if (!(await showConfirm(t('backup.confirm_delete')))) return;
    try {
        const res = await apiCall('/api/backup/archives', { method: 'DELETE', body: { path } });
        const data = (await res.json().catch(() => ({}))) as { detail?: unknown };
        if (!res.ok) throw new Error(translateApiDetail(data.detail) || t('backup.failed'));
        _setStatus(`<i class="fas fa-circle-check mr-1.5"></i>${escapeHtml(t('backup.deleted'))}`, 'success');
        await loadBackupPanel();
    } catch (e) {
        _setStatus(
            `<i class="fas fa-triangle-exclamation mr-1.5"></i>${escapeHtml(e instanceof Error ? e.message : String(e))}`,
            'error',
        );
    }
}

export function setBackupScheduleInterval(value: string): void {
    const select = document.getElementById('backup_schedule_interval') as HTMLSelectElement | null;
    if (!select) return;
    select.value = value;
    upgradeNativeSelect(select);
}

export function syncBackupScheduleDropdown(): void {
    const select = document.getElementById('backup_schedule_interval') as HTMLSelectElement | null;
    if (!select) return;
    upgradeNativeSelect(select);
}

if (typeof document !== 'undefined') {
    document.addEventListener('change', (e) => {
        const target = e.target;
        if (!(target instanceof HTMLSelectElement)) return;
        if (target.id === 'backup_remote_provider') {
            _toggleRemoteFields(target.value || 'none');
        }
    });
}

export async function testBackupRemote(): Promise<void> {
    if (!_remoteUiAvailable()) return;
    _setStatus(`<i class="fas fa-spinner fa-spin mr-1.5"></i>${escapeHtml(t('backup.testing_remote'))}`, 'info');
    try {
        await saveBackupSettings();
        const res = await apiCall('/api/backup/remote/test', { method: 'POST' });
        const data = (await res.json().catch(() => ({}))) as { detail?: unknown; ok?: boolean; provider?: string };
        if (!res.ok) throw new Error(translateApiDetail(data.detail) || t('backup.failed'));
        _setStatus(
            `<i class="fas fa-circle-check mr-1.5"></i>${escapeHtml(t('backup.remote_ok', { provider: data.provider || 'remote' }))}`,
            'success',
        );
        _toggleRemoteArchivesSection(true);
        await loadRemoteBackupArchives();
    } catch (e) {
        _setStatus(
            `<i class="fas fa-triangle-exclamation mr-1.5"></i>${escapeHtml(e instanceof Error ? e.message : String(e))}`,
            'error',
        );
    }
}

export async function pullRemoteBackup(name: string): Promise<void> {
    if (!name) return;
    _setStatus(`<i class="fas fa-spinner fa-spin mr-1.5"></i>${escapeHtml(t('backup.pulling_remote'))}`, 'info');
    try {
        const res = await apiCall('/api/backup/remote/pull', { method: 'POST', body: { name } });
        const data = (await res.json().catch(() => ({}))) as {
            detail?: unknown;
            name?: string;
            size?: number;
        };
        if (!res.ok) throw new Error(translateApiDetail(data.detail) || t('backup.failed'));
        _setStatus(
            `<i class="fas fa-circle-check mr-1.5"></i>${escapeHtml(t('backup.pull_ok', { name: data.name || name, size: _formatBytes(data.size || 0) }))}`,
            'success',
        );
        await loadBackupPanel();
    } catch (e) {
        _setStatus(
            `<i class="fas fa-triangle-exclamation mr-1.5"></i>${escapeHtml(e instanceof Error ? e.message : String(e))}`,
            'error',
        );
    }
}

export async function restoreRemoteBackup(name: string): Promise<void> {
    if (!name) return;
    if (!(await showConfirm(t('backup.confirm_remote_restore')))) return;
    _setStatus(`<i class="fas fa-spinner fa-spin mr-1.5"></i>${escapeHtml(t('backup.restoring'))}`, 'info');
    try {
        const opts = _optionsFromForm();
        const res = await apiCall('/api/backup/remote/restore', {
            method: 'POST',
            body: {
                name,
                include_optional: opts.include_optional,
                include_frigate_media: opts.include_frigate_media,
                refetch_addons: opts.refetch_addons,
                auto_pre_backup: true,
            },
        });
        const data = (await res.json().catch(() => ({}))) as {
            detail?: unknown;
            restored_files?: number;
            pre_restore_backup?: string | null;
            restarting?: boolean;
        };
        if (!res.ok) throw new Error(translateApiDetail(data.detail) || t('backup.failed'));
        _handleRestoreSuccess(data);
        await _afterRestoreComplete(data.restarting);
    } catch (e) {
        _setStatus(
            `<i class="fas fa-triangle-exclamation mr-1.5"></i>${escapeHtml(e instanceof Error ? e.message : String(e))}`,
            'error',
        );
    }
}

export async function downloadBackupArchive(path: string): Promise<void> {
    if (!path) return;
    _setStatus(`<i class="fas fa-spinner fa-spin mr-1.5"></i>${escapeHtml(t('backup.downloading'))}`, 'info');
    try {
        const res = await apiCall(`/api/backup/archives/download?path=${encodeURIComponent(path)}`);
        if (!res.ok) {
            const data = (await res.json().catch(() => ({}))) as { detail?: unknown };
            throw new Error(translateApiDetail(data.detail) || t('backup.failed'));
        }
        const blob = await res.blob();
        const name = path.split('/').pop() || 'backup.hyvebak';
        const objectUrl = URL.createObjectURL(blob);
        const anchor = document.createElement('a');
        anchor.href = objectUrl;
        anchor.download = name;
        document.body.appendChild(anchor);
        anchor.click();
        document.body.removeChild(anchor);
        URL.revokeObjectURL(objectUrl);
        _setStatus(`<i class="fas fa-circle-check mr-1.5"></i>${escapeHtml(t('backup.download_ok'))}`, 'success');
    } catch (e) {
        _setStatus(
            `<i class="fas fa-triangle-exclamation mr-1.5"></i>${escapeHtml(e instanceof Error ? e.message : String(e))}`,
            'error',
        );
    }
}

export function pickBackupUpload(): void {
    _el<HTMLInputElement>('backup-upload-input')?.click();
}

export async function uploadBackupArchive(file: File): Promise<void> {
    if (!file) return;
    _setStatus(`<i class="fas fa-spinner fa-spin mr-1.5"></i>${escapeHtml(t('backup.uploading'))}`, 'info');
    try {
        const form = new FormData();
        form.append('file', file, file.name);
        const res = await apiCall('/api/backup/archives/upload', { method: 'POST', body: form });
        const data = (await res.json().catch(() => ({}))) as { detail?: unknown; name?: string };
        if (!res.ok) throw new Error(translateApiDetail(data.detail) || t('backup.failed'));
        _setStatus(
            `<i class="fas fa-circle-check mr-1.5"></i>${escapeHtml(t('backup.upload_ok', { name: data.name || file.name }))}`,
            'success',
        );
        await loadBackupPanel();
    } catch (e) {
        _setStatus(
            `<i class="fas fa-triangle-exclamation mr-1.5"></i>${escapeHtml(e instanceof Error ? e.message : String(e))}`,
            'error',
        );
    }
}

if (typeof document !== 'undefined') {
    document.addEventListener('change', (e) => {
        const target = e.target;
        if (target instanceof HTMLInputElement && target.id === 'backup-encrypt-at-rest') {
            _updateEncryptionKeySection(
                { ..._cachedBackupSettings, encrypt_at_rest: target.checked },
                _cachedEncryptionKeyStatus,
            );
        }
    });
    document.addEventListener('change', (e) => {
        const target = e.target;
        if (!(target instanceof HTMLInputElement) || target.id !== 'backup-upload-input') return;
        const file = target.files?.[0];
        target.value = '';
        if (file) void uploadBackupArchive(file);
    });
}
