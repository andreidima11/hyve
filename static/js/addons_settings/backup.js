/**
 * Settings → Backup & restore hub panel.
 */
import { apiCall } from '../api.js';
import { t, translateApiDetail } from '../lang/index.js';
import { showConfirm, escapeHtml, showToast } from '../utils.js';
import { isExplicitNonAdmin } from '../user_context.js';
import { watchServerRestartAndReload } from '../startup_status.js';
let _cachedBackupSettings;
let _cachedEncryptionKeyStatus;
function _remoteUiAvailable() {
    return !!_el('backup-remote-enabled');
}
function _el(id) {
    return document.getElementById(id);
}
function _optionsFromForm() {
    return {
        include_optional: !!_el('backup-include-optional')?.checked,
        include_frigate_media: !!_el('backup-include-frigate-media')?.checked,
        refetch_addons: !!_el('backup-refetch-addons')?.checked,
    };
}
function _formatBytes(size) {
    const n = Number(size) || 0;
    if (n < 1024)
        return `${n} B`;
    if (n < 1024 * 1024)
        return `${(n / 1024).toFixed(1)} KB`;
    if (n < 1024 * 1024 * 1024)
        return `${(n / (1024 * 1024)).toFixed(1)} MB`;
    return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}
function _formatWhen(iso) {
    const raw = String(iso || '').trim();
    if (!raw)
        return '—';
    const d = new Date(raw);
    if (Number.isNaN(d.getTime()))
        return raw;
    return d.toLocaleString();
}
function _setStatus(html, kind = 'info') {
    const box = _el('backup-status');
    if (!box)
        return;
    if (kind === 'hidden' || !html) {
        box.classList.add('hidden');
        box.innerHTML = '';
        return;
    }
    const styles = {
        info: 'border-cyan-500/20 bg-cyan-500/5 text-cyan-100',
        success: 'border-emerald-500/20 bg-emerald-500/5 text-emerald-100',
        warning: 'border-amber-500/20 bg-amber-500/5 text-amber-100',
        error: 'border-red-500/20 bg-red-500/5 text-red-100',
    };
    box.className = `text-[11px] rounded-xl p-3 border ${styles[kind] || styles.info}`;
    box.innerHTML = html;
    box.classList.remove('hidden');
}
function _setMaintenanceBanner(active, reason = '') {
    const banner = _el('backup-maintenance-banner');
    if (!banner)
        return;
    if (!active) {
        banner.classList.add('hidden');
        banner.innerHTML = '';
        return;
    }
    banner.className =
        'text-[11px] rounded-xl p-3 border border-amber-500/25 bg-amber-500/10 text-amber-100';
    banner.innerHTML = `<i class="fas fa-screwdriver-wrench mr-1.5"></i>${escapeHtml(reason ? `${t('backup.maintenance_active')} (${reason})` : t('backup.maintenance_active'))}`;
    banner.classList.remove('hidden');
}
function _toggleRemoteArchivesSection(show) {
    _el('backup-remote-archives-section')?.classList.toggle('hidden', !show);
}
function _remoteArchiveRowHtml(row) {
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
function _renderRemoteArchives(archives) {
    const list = _el('backup-remote-list');
    if (!list)
        return;
    if (!archives.length) {
        list.innerHTML = `<div class="text-center py-8 text-slate-500 text-xs">${escapeHtml(t('backup.no_remote_archives'))}</div>`;
        return;
    }
    list.innerHTML = archives.map(_remoteArchiveRowHtml).join('');
}
export async function loadRemoteBackupArchives() {
    if (!_remoteUiAvailable())
        return;
    const list = _el('backup-remote-list');
    if (list) {
        list.innerHTML = `<div class="text-center py-6 text-slate-500 text-xs"><i class="fas fa-spinner fa-spin mr-2"></i>${escapeHtml(t('backup.remote_loading'))}</div>`;
    }
    try {
        const res = await apiCall('/api/backup/remote/archives');
        const data = (await res.json().catch(() => ({})));
        if (!res.ok)
            throw new Error(translateApiDetail(data.detail) || t('backup.failed'));
        _renderRemoteArchives(data.archives || []);
    }
    catch (e) {
        if (list)
            list.innerHTML = '';
        _setStatus(`<i class="fas fa-triangle-exclamation mr-1.5"></i>${escapeHtml(e instanceof Error ? e.message : String(e))}`, 'error');
    }
}
async function _fetchEncryptionKey() {
    const res = await apiCall('/api/backup/encryption-key');
    const data = (await res.json().catch(() => ({})));
    if (!res.ok)
        throw new Error(translateApiDetail(data.detail) || t('backup.failed'));
    const key = String(data.key || '').trim();
    if (!key)
        throw new Error(t('backup.encryption_key_missing'));
    return { source: String(data.source || 'file'), key };
}
function _downloadKeyFile(key) {
    const blob = new Blob([key], { type: 'application/octet-stream' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'backup_archive.key';
    a.click();
    URL.revokeObjectURL(url);
}
function _updateEncryptionKeySection(settings, keyStatus) {
    const section = _el('backup-encryption-key-section');
    const statusEl = _el('backup-encryption-key-status');
    const showBtn = _el('backup-show-key-btn');
    const dlBtn = _el('backup-download-key-btn');
    if (!section)
        return;
    const wantsEncrypt = !!settings?.encrypt_at_rest;
    const configured = !!keyStatus?.configured;
    section.classList.toggle('hidden', !(wantsEncrypt || configured));
    if (wantsEncrypt || configured) {
        if (statusEl) {
            statusEl.textContent = configured
                ? t(keyStatus?.source === 'env'
                    ? 'backup.encryption_key_source_env'
                    : 'backup.encryption_key_source_file', { path: keyStatus?.file_path || 'secrets/backup_archive.key' })
                : t('backup.encryption_key_pending');
        }
        if (showBtn)
            showBtn.disabled = !configured;
        if (dlBtn)
            dlBtn.disabled = !configured;
    }
}
function _showEncryptionKeyModal(key, source) {
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
                        class="w-full bg-slate-900 border border-white/10 rounded-xl p-3 text-xs mono text-slate-200 select-all" />
                </div>
                <div class="app-modal-footer justify-end gap-2">
                    <button type="button" data-config-action="copyBackupEncryptionKey" id="backup-encryption-key-copy-btn" class="hy-btn hy-btn-ghost text-[11px]"></button>
                    <button type="button" data-config-action="downloadBackupEncryptionKeyFromModal" id="backup-encryption-key-modal-download-btn" class="hy-btn hy-btn-primary text-[11px]"></button>
                </div>
            </div>`;
        document.body.appendChild(modal);
        modal.addEventListener('click', (e) => {
            if (e.target === modal)
                hideBackupEncryptionKeyModal();
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
    const input = modal.querySelector('#backup-encryption-key-modal-input');
    const copyBtn = modal.querySelector('#backup-encryption-key-copy-btn');
    const dlBtn = modal.querySelector('#backup-encryption-key-modal-download-btn');
    if (title)
        title.textContent = t('backup.encryption_key_modal_title');
    if (subtitle) {
        subtitle.textContent = source === 'env'
            ? t('backup.encryption_key_source_env')
            : t('backup.encryption_key_source_file', { path: 'secrets/backup_archive.key' });
    }
    if (warning)
        warning.textContent = t('backup.encryption_key_modal_warning');
    if (input)
        input.value = key;
    if (copyBtn)
        copyBtn.innerHTML = `<i class="fas fa-copy"></i><span>${escapeHtml(t('backup.copy_encryption_key'))}</span>`;
    if (dlBtn)
        dlBtn.innerHTML = `<i class="fas fa-download"></i><span>${escapeHtml(t('backup.download_encryption_key'))}</span>`;
    modal.dataset.backupKey = key;
    modal.classList.remove('hidden');
    input?.focus();
    input?.select();
}
export function hideBackupEncryptionKeyModal() {
    document.getElementById('backup-encryption-key-modal')?.classList.add('hidden');
}
export async function showBackupEncryptionKey() {
    if (!(await showConfirm(t('backup.encryption_key_confirm'))))
        return;
    _setStatus(`<i class="fas fa-spinner fa-spin mr-1.5"></i>${escapeHtml(t('backup.encryption_key_loading'))}`, 'info');
    try {
        const data = await _fetchEncryptionKey();
        _setStatus('', 'hidden');
        _showEncryptionKeyModal(data.key, data.source);
    }
    catch (e) {
        _setStatus(`<i class="fas fa-triangle-exclamation mr-1.5"></i>${escapeHtml(e instanceof Error ? e.message : String(e))}`, 'error');
    }
}
export function downloadBackupEncryptionKeyFromModal() {
    const modal = document.getElementById('backup-encryption-key-modal');
    const key = modal?.dataset.backupKey || '';
    if (!key)
        return;
    _downloadKeyFile(key);
    _setStatus(`<i class="fas fa-circle-check mr-1.5"></i>${escapeHtml(t('backup.encryption_key_downloaded'))}`, 'success');
}
export async function downloadBackupEncryptionKey() {
    if (!(await showConfirm(t('backup.encryption_key_confirm'))))
        return;
    try {
        const data = await _fetchEncryptionKey();
        _downloadKeyFile(data.key);
        _setStatus(`<i class="fas fa-circle-check mr-1.5"></i>${escapeHtml(t('backup.encryption_key_downloaded'))}`, 'success');
    }
    catch (e) {
        _setStatus(`<i class="fas fa-triangle-exclamation mr-1.5"></i>${escapeHtml(e instanceof Error ? e.message : String(e))}`, 'error');
    }
}
export async function copyBackupEncryptionKey() {
    const modal = document.getElementById('backup-encryption-key-modal');
    const key = modal?.dataset.backupKey || '';
    if (!key)
        return;
    try {
        await navigator.clipboard.writeText(key);
        _setStatus(`<i class="fas fa-circle-check mr-1.5"></i>${escapeHtml(t('backup.encryption_key_copied'))}`, 'success');
    }
    catch {
        const input = modal?.querySelector('#backup-encryption-key-modal-input');
        input?.select();
        document.execCommand('copy');
        _setStatus(`<i class="fas fa-circle-check mr-1.5"></i>${escapeHtml(t('backup.encryption_key_copied'))}`, 'success');
    }
}
function _isEncryptedPath(path) {
    return String(path || '').endsWith('.enc');
}
function _promptDecryptionKey() {
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
                            class="w-full bg-slate-900 border border-white/10 rounded-xl p-3 text-sm mono text-slate-200 focus:border-accent outline-none" />
                    </div>
                    <div class="app-modal-footer justify-end gap-2">
                        <button type="button" id="backup-decrypt-key-cancel" class="px-4 py-2 rounded-xl text-sm font-bold text-slate-400 hover:bg-white/5 transition-colors"></button>
                        <button type="button" id="backup-decrypt-key-skip" class="px-4 py-2 rounded-xl text-sm font-bold text-slate-300 hover:bg-white/5 transition-colors"></button>
                        <button type="button" id="backup-decrypt-key-ok" class="px-4 py-2 rounded-xl text-sm font-bold text-white bg-accent hover:bg-accent-hover transition-colors"></button>
                    </div>
                </div>`;
            document.body.appendChild(modal);
            modal.addEventListener('click', (e) => {
                if (e.target === modal)
                    resolve(null);
            });
            modal.querySelector('.app-modal-panel')?.addEventListener('click', (e) => e.stopPropagation());
        }
        const title = modal.querySelector('#backup-decrypt-key-title');
        const prompt = modal.querySelector('#backup-decrypt-key-prompt');
        const hint = modal.querySelector('#backup-decrypt-key-hint');
        const input = modal.querySelector('#backup-decrypt-key-input');
        const cancelBtn = modal.querySelector('#backup-decrypt-key-cancel');
        const skipBtn = modal.querySelector('#backup-decrypt-key-skip');
        const okBtn = modal.querySelector('#backup-decrypt-key-ok');
        if (title)
            title.textContent = t('backup.decrypt_key_title');
        if (prompt)
            prompt.textContent = t('backup.decrypt_key_prompt');
        if (hint)
            hint.textContent = t('backup.decrypt_key_hint');
        if (input) {
            input.value = '';
            input.placeholder = t('backup.decrypt_key_placeholder');
        }
        if (cancelBtn)
            cancelBtn.textContent = t('common.cancel');
        if (skipBtn)
            skipBtn.textContent = t('backup.decrypt_key_skip');
        if (okBtn)
            okBtn.textContent = t('backup.decrypt_key_continue');
        const close = (value) => {
            modal?.classList.add('hidden');
            resolve(value);
        };
        cancelBtn?.replaceWith(cancelBtn.cloneNode(true));
        skipBtn?.replaceWith(skipBtn.cloneNode(true));
        okBtn?.replaceWith(okBtn.cloneNode(true));
        const newCancel = modal.querySelector('#backup-decrypt-key-cancel');
        const newSkip = modal.querySelector('#backup-decrypt-key-skip');
        const newOk = modal.querySelector('#backup-decrypt-key-ok');
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
async function _decryptionKeyForPath(path) {
    if (!_isEncryptedPath(path))
        return undefined;
    const key = await _promptDecryptionKey();
    if (key === null)
        return null;
    return key || undefined;
}
function _archiveRowHtml(row) {
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
function _applySettings(settings) {
    if (!settings)
        return;
    const interval = settings.schedule_interval || 'never';
    setBackupScheduleInterval(interval);
    const retention = _el('backup_retention_count');
    if (retention && settings.retention_count != null)
        retention.value = String(settings.retention_count);
    const pre = _el('backup_pre_restore_retention_count');
    if (pre && settings.pre_restore_retention_count != null) {
        pre.value = String(settings.pre_restore_retention_count);
    }
    const opt = _el('backup-include-optional');
    if (opt)
        opt.checked = !!settings.include_optional;
    const frigate = _el('backup-include-frigate-media');
    if (frigate)
        frigate.checked = !!settings.include_frigate_media;
    const refetch = _el('backup-refetch-addons');
    if (refetch)
        refetch.checked = settings.refetch_addons !== false;
    const encrypt = _el('backup-encrypt-at-rest');
    if (encrypt)
        encrypt.checked = !!settings.encrypt_at_rest;
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
            }
            else {
                last.textContent = t('backup.last_scheduled_never');
            }
        }
        return;
    }
    const remote = settings.remote || {};
    const remoteEnabled = _el('backup-remote-enabled');
    if (remoteEnabled)
        remoteEnabled.checked = !!remote.enabled;
    const provider = _el('backup_remote_provider');
    if (provider)
        provider.value = remote.provider || 'none';
    _toggleRemoteFields(provider?.value || 'none');
    const remoteRetention = _el('backup_remote_retention');
    if (remoteRetention && remote.retention_count != null) {
        remoteRetention.value = String(remote.retention_count);
    }
    const s3 = remote.s3 || {};
    if (_el('backup_s3_bucket'))
        _el('backup_s3_bucket').value = s3.bucket || '';
    if (_el('backup_s3_prefix'))
        _el('backup_s3_prefix').value = s3.prefix || 'hyve/';
    if (_el('backup_s3_region'))
        _el('backup_s3_region').value = s3.region || '';
    if (_el('backup_s3_endpoint'))
        _el('backup_s3_endpoint').value = s3.endpoint_url || '';
    const sftp = remote.sftp || {};
    if (_el('backup_sftp_host'))
        _el('backup_sftp_host').value = sftp.host || '';
    if (_el('backup_sftp_port'))
        _el('backup_sftp_port').value = String(sftp.port || 22);
    if (_el('backup_sftp_username'))
        _el('backup_sftp_username').value = sftp.username || '';
    if (_el('backup_sftp_password') && sftp.password) {
        _el('backup_sftp_password').value = sftp.password;
    }
    if (_el('backup_sftp_path'))
        _el('backup_sftp_path').value = sftp.remote_path || '/backups/hyve';
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
        }
        else {
            last.textContent = t('backup.last_scheduled_never');
        }
    }
}
function _toggleRemoteFields(provider) {
    if (!_remoteUiAvailable())
        return;
    _el('backup-remote-s3-fields')?.classList.toggle('hidden', provider !== 's3');
    _el('backup-remote-sftp-fields')?.classList.toggle('hidden', provider !== 'sftp');
}
function _remoteSettingsFromForm() {
    const provider = _el('backup_remote_provider')?.value || 'none';
    return {
        enabled: !!_el('backup-remote-enabled')?.checked,
        provider,
        upload_on_create: true,
        retention_count: Math.max(0, parseInt(_el('backup_remote_retention')?.value || '5', 10) || 0),
        s3: {
            bucket: _el('backup_s3_bucket')?.value || '',
            prefix: _el('backup_s3_prefix')?.value || 'hyve/',
            region: _el('backup_s3_region')?.value || '',
            endpoint_url: _el('backup_s3_endpoint')?.value || '',
        },
        sftp: {
            host: _el('backup_sftp_host')?.value || '',
            port: parseInt(_el('backup_sftp_port')?.value || '22', 10) || 22,
            username: _el('backup_sftp_username')?.value || '',
            password: _el('backup_sftp_password')?.value || '',
            remote_path: _el('backup_sftp_path')?.value || '/backups/hyve',
        },
    };
}
function _settingsFromForm() {
    const settings = {
        schedule_interval: _el('backup_schedule_interval')?.value || 'never',
        retention_count: Math.max(1, parseInt(_el('backup_retention_count')?.value || '10', 10) || 10),
        pre_restore_retention_count: Math.max(1, parseInt(_el('backup_pre_restore_retention_count')?.value || '3', 10) || 3),
        include_optional: !!_el('backup-include-optional')?.checked,
        include_frigate_media: !!_el('backup-include-frigate-media')?.checked,
        refetch_addons: !!_el('backup-refetch-addons')?.checked,
        encrypt_at_rest: !!_el('backup-encrypt-at-rest')?.checked,
    };
    if (_remoteUiAvailable()) {
        settings.remote = _remoteSettingsFromForm();
    }
    else if (_cachedBackupSettings?.remote) {
        settings.remote = _cachedBackupSettings.remote;
    }
    return settings;
}
function _renderArchives(archives) {
    const list = _el('backup-list');
    const count = _el('backup-count');
    if (count)
        count.textContent = t('backup.archives_count', { count: archives.length });
    if (!list)
        return;
    if (!archives.length) {
        list.innerHTML = `<div class="text-center py-10 text-slate-500 text-xs">${escapeHtml(t('backup.no_archives'))}</div>`;
        return;
    }
    list.innerHTML = archives.map(_archiveRowHtml).join('');
}
export async function loadBackupPanel() {
    if (isExplicitNonAdmin())
        return;
    _setStatus('', 'hidden');
    const list = _el('backup-list');
    if (list) {
        list.innerHTML = `<div class="text-center py-8 text-slate-500 text-xs"><i class="fas fa-spinner fa-spin mr-2"></i>${escapeHtml(t('backup.loading'))}</div>`;
    }
    try {
        const res = await apiCall('/api/backup/status');
        if (!res.ok) {
            const err = (await res.json().catch(() => ({})));
            throw new Error(translateApiDetail(err.detail) || res.statusText || t('common.error'));
        }
        const data = (await res.json());
        _cachedBackupSettings = data.settings;
        _cachedEncryptionKeyStatus = data.encryption_key;
        _setMaintenanceBanner(!!data.maintenance, data.maintenance_reason || '');
        _applySettings(data.settings);
        _updateEncryptionKeySection(data.settings, data.encryption_key);
        _renderArchives(data.archives || []);
        const showRemote = _remoteUiAvailable() && !!(data.remote_enabled && data.remote_configured);
        _toggleRemoteArchivesSection(showRemote);
        if (showRemote)
            await loadRemoteBackupArchives();
    }
    catch (e) {
        _setStatus(`<i class="fas fa-triangle-exclamation mr-1.5"></i>${escapeHtml(e instanceof Error ? e.message : String(e))}`, 'error');
        if (list)
            list.innerHTML = '';
    }
}
export async function createBackup() {
    const btn = _el('backup-create-btn');
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
        const data = (await res.json().catch(() => ({})));
        if (!res.ok) {
            throw new Error(translateApiDetail(data.detail) || t('backup.failed'));
        }
        _setStatus(`<i class="fas fa-circle-check mr-1.5"></i>${escapeHtml(t('backup.create_ok', { files: data.files || 0 }))}`, 'success');
        await loadBackupPanel();
    }
    catch (e) {
        _setStatus(`<i class="fas fa-triangle-exclamation mr-1.5"></i>${escapeHtml(e instanceof Error ? e.message : String(e))}`, 'error');
    }
    finally {
        if (btn) {
            btn.disabled = false;
            btn.innerHTML = `<i class="fas fa-plus"></i><span>${escapeHtml(t('backup.create_btn'))}</span>`;
        }
    }
}
export async function verifyBackup(path) {
    if (!path)
        return;
    const decryptionKey = await _decryptionKeyForPath(path);
    if (decryptionKey === null)
        return;
    _setStatus(`<i class="fas fa-spinner fa-spin mr-1.5"></i>${escapeHtml(t('backup.verifying'))}`, 'info');
    try {
        const res = await apiCall('/api/backup/verify', {
            method: 'POST',
            body: { path, decryption_key: decryptionKey },
        });
        const data = (await res.json().catch(() => ({})));
        if (!res.ok)
            throw new Error(translateApiDetail(data.detail) || t('backup.failed'));
        _setStatus(`<i class="fas fa-circle-check mr-1.5"></i>${escapeHtml(t('backup.verify_ok', { files: data.files || 0 }))}`, 'success');
    }
    catch (e) {
        _setStatus(`<i class="fas fa-triangle-exclamation mr-1.5"></i>${escapeHtml(e instanceof Error ? e.message : String(e))}`, 'error');
    }
}
function _handleRestoreSuccess(data) {
    let msg = t('backup.restore_ok', { files: data.restored_files || 0 });
    if (data.pre_restore_backup)
        msg += ` ${t('backup.pre_restore_created')}`;
    if (data.restarting) {
        showToast(t('backup.restore_restarting'), 'info', 8000);
        watchServerRestartAndReload();
        msg += ` ${t('backup.restore_restarting')}`;
    }
    _setStatus(`<i class="fas fa-circle-check mr-1.5"></i>${escapeHtml(msg)}`, 'success');
}
async function _afterRestoreComplete(restarting) {
    if (!restarting)
        await loadBackupPanel();
}
export async function restoreBackup(path) {
    if (!path)
        return;
    if (!(await showConfirm(t('backup.confirm_restore'))))
        return;
    const decryptionKey = await _decryptionKeyForPath(path);
    if (decryptionKey === null)
        return;
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
        const data = (await res.json().catch(() => ({})));
        if (!res.ok)
            throw new Error(translateApiDetail(data.detail) || t('backup.failed'));
        _handleRestoreSuccess(data);
        await _afterRestoreComplete(data.restarting);
    }
    catch (e) {
        _setStatus(`<i class="fas fa-triangle-exclamation mr-1.5"></i>${escapeHtml(e instanceof Error ? e.message : String(e))}`, 'error');
    }
}
export async function rollbackBackup(path) {
    if (!path)
        return;
    if (!(await showConfirm(t('backup.confirm_rollback'))))
        return;
    const decryptionKey = await _decryptionKeyForPath(path);
    if (decryptionKey === null)
        return;
    _setStatus(`<i class="fas fa-spinner fa-spin mr-1.5"></i>${escapeHtml(t('backup.rollbacking'))}`, 'info');
    try {
        const res = await apiCall('/api/backup/rollback', {
            method: 'POST',
            body: { path, decryption_key: decryptionKey },
        });
        const data = (await res.json().catch(() => ({})));
        if (!res.ok)
            throw new Error(translateApiDetail(data.detail) || t('backup.failed'));
        let msg = t('backup.rollback_ok', { files: data.restored_files || 0 });
        if (data.restarting) {
            showToast(t('backup.restore_restarting'), 'info', 8000);
            watchServerRestartAndReload();
            msg += ` ${t('backup.restore_restarting')}`;
        }
        _setStatus(`<i class="fas fa-circle-check mr-1.5"></i>${escapeHtml(msg)}`, 'success');
        if (!data.restarting)
            await loadBackupPanel();
    }
    catch (e) {
        _setStatus(`<i class="fas fa-triangle-exclamation mr-1.5"></i>${escapeHtml(e instanceof Error ? e.message : String(e))}`, 'error');
    }
}
export async function saveBackupSettings() {
    const btn = _el('backup-save-settings-btn');
    if (btn) {
        btn.disabled = true;
        btn.innerHTML = `<i class="fas fa-spinner fa-spin"></i><span>${escapeHtml(t('backup.saving'))}</span>`;
    }
    try {
        const res = await apiCall('/api/backup/settings', {
            method: 'POST',
            body: _settingsFromForm(),
        });
        const data = (await res.json().catch(() => ({})));
        if (!res.ok)
            throw new Error(translateApiDetail(data.detail) || t('backup.failed'));
        _cachedBackupSettings = data;
        _setStatus(`<i class="fas fa-circle-check mr-1.5"></i>${escapeHtml(t('backup.settings_saved'))}`, 'success');
        _applySettings(data);
    }
    catch (e) {
        _setStatus(`<i class="fas fa-triangle-exclamation mr-1.5"></i>${escapeHtml(e instanceof Error ? e.message : String(e))}`, 'error');
    }
    finally {
        if (btn) {
            btn.disabled = false;
            btn.innerHTML = `<i class="fas fa-check"></i><span>${escapeHtml(t('backup.save_settings'))}</span>`;
        }
    }
}
export async function deleteBackupArchive(path) {
    if (!path)
        return;
    if (!(await showConfirm(t('backup.confirm_delete'))))
        return;
    try {
        const res = await apiCall('/api/backup/archives', { method: 'DELETE', body: { path } });
        const data = (await res.json().catch(() => ({})));
        if (!res.ok)
            throw new Error(translateApiDetail(data.detail) || t('backup.failed'));
        _setStatus(`<i class="fas fa-circle-check mr-1.5"></i>${escapeHtml(t('backup.deleted'))}`, 'success');
        await loadBackupPanel();
    }
    catch (e) {
        _setStatus(`<i class="fas fa-triangle-exclamation mr-1.5"></i>${escapeHtml(e instanceof Error ? e.message : String(e))}`, 'error');
    }
}
function _intervalLabel(val) {
    const key = {
        never: 'updates.interval_never',
        daily: 'updates.interval_daily',
        weekly: 'updates.interval_weekly',
        monthly: 'updates.interval_monthly',
    }[val];
    return key ? t(key) : val;
}
let _backupDropdownBound = false;
if (typeof document !== 'undefined' && !_backupDropdownBound) {
    _backupDropdownBound = true;
    document.addEventListener('click', (e) => {
        const dd = document.getElementById('backup_schedule_dropdown');
        if (!dd)
            return;
        const target = e.target;
        if (!(target instanceof Element))
            return;
        const toggleBtn = target.closest('[data-action="toggle-backup-schedule"]');
        if (toggleBtn && dd.contains(toggleBtn)) {
            e.preventDefault();
            e.stopPropagation();
            dd.dataset.open = dd.dataset.open === 'true' ? 'false' : 'true';
            return;
        }
        const opt = target.closest('.dashboard-custom-select__option');
        if (opt && dd.contains(opt)) {
            e.preventDefault();
            e.stopPropagation();
            const value = opt.dataset.value || '';
            const labelKey = opt.dataset.labelKey;
            const label = labelKey ? t(labelKey) : (opt.textContent || '').trim();
            setBackupScheduleInterval(value, label);
            return;
        }
        if (!dd.contains(target))
            dd.dataset.open = 'false';
    });
}
export function setBackupScheduleInterval(value, label) {
    const dd = document.getElementById('backup_schedule_dropdown');
    const hidden = document.getElementById('backup_schedule_interval');
    const lbl = label || _intervalLabel(value);
    if (dd) {
        dd.dataset.open = 'false';
        const valueEl = dd.querySelector('.dashboard-custom-select__value');
        if (valueEl)
            valueEl.textContent = lbl;
        dd.querySelectorAll('.dashboard-custom-select__option').forEach((o) => {
            const opt = o;
            opt.dataset.selected = opt.dataset.value === value ? 'true' : 'false';
        });
    }
    if (hidden)
        hidden.value = value;
}
export function syncBackupScheduleDropdown() {
    const hidden = document.getElementById('backup_schedule_interval');
    if (!hidden)
        return;
    setBackupScheduleInterval(hidden.value || 'never');
}
if (typeof document !== 'undefined') {
    document.addEventListener('change', (e) => {
        const target = e.target;
        if (!(target instanceof HTMLSelectElement))
            return;
        if (target.id === 'backup_remote_provider') {
            _toggleRemoteFields(target.value || 'none');
        }
    });
}
export async function testBackupRemote() {
    if (!_remoteUiAvailable())
        return;
    _setStatus(`<i class="fas fa-spinner fa-spin mr-1.5"></i>${escapeHtml(t('backup.testing_remote'))}`, 'info');
    try {
        await saveBackupSettings();
        const res = await apiCall('/api/backup/remote/test', { method: 'POST' });
        const data = (await res.json().catch(() => ({})));
        if (!res.ok)
            throw new Error(translateApiDetail(data.detail) || t('backup.failed'));
        _setStatus(`<i class="fas fa-circle-check mr-1.5"></i>${escapeHtml(t('backup.remote_ok', { provider: data.provider || 'remote' }))}`, 'success');
        _toggleRemoteArchivesSection(true);
        await loadRemoteBackupArchives();
    }
    catch (e) {
        _setStatus(`<i class="fas fa-triangle-exclamation mr-1.5"></i>${escapeHtml(e instanceof Error ? e.message : String(e))}`, 'error');
    }
}
export async function pullRemoteBackup(name) {
    if (!name)
        return;
    _setStatus(`<i class="fas fa-spinner fa-spin mr-1.5"></i>${escapeHtml(t('backup.pulling_remote'))}`, 'info');
    try {
        const res = await apiCall('/api/backup/remote/pull', { method: 'POST', body: { name } });
        const data = (await res.json().catch(() => ({})));
        if (!res.ok)
            throw new Error(translateApiDetail(data.detail) || t('backup.failed'));
        _setStatus(`<i class="fas fa-circle-check mr-1.5"></i>${escapeHtml(t('backup.pull_ok', { name: data.name || name, size: _formatBytes(data.size || 0) }))}`, 'success');
        await loadBackupPanel();
    }
    catch (e) {
        _setStatus(`<i class="fas fa-triangle-exclamation mr-1.5"></i>${escapeHtml(e instanceof Error ? e.message : String(e))}`, 'error');
    }
}
export async function restoreRemoteBackup(name) {
    if (!name)
        return;
    if (!(await showConfirm(t('backup.confirm_remote_restore'))))
        return;
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
        const data = (await res.json().catch(() => ({})));
        if (!res.ok)
            throw new Error(translateApiDetail(data.detail) || t('backup.failed'));
        _handleRestoreSuccess(data);
        await _afterRestoreComplete(data.restarting);
    }
    catch (e) {
        _setStatus(`<i class="fas fa-triangle-exclamation mr-1.5"></i>${escapeHtml(e instanceof Error ? e.message : String(e))}`, 'error');
    }
}
export async function downloadBackupArchive(path) {
    if (!path)
        return;
    _setStatus(`<i class="fas fa-spinner fa-spin mr-1.5"></i>${escapeHtml(t('backup.downloading'))}`, 'info');
    try {
        const res = await apiCall(`/api/backup/archives/download?path=${encodeURIComponent(path)}`);
        if (!res.ok) {
            const data = (await res.json().catch(() => ({})));
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
    }
    catch (e) {
        _setStatus(`<i class="fas fa-triangle-exclamation mr-1.5"></i>${escapeHtml(e instanceof Error ? e.message : String(e))}`, 'error');
    }
}
export function pickBackupUpload() {
    _el('backup-upload-input')?.click();
}
export async function uploadBackupArchive(file) {
    if (!file)
        return;
    _setStatus(`<i class="fas fa-spinner fa-spin mr-1.5"></i>${escapeHtml(t('backup.uploading'))}`, 'info');
    try {
        const form = new FormData();
        form.append('file', file, file.name);
        const res = await apiCall('/api/backup/archives/upload', { method: 'POST', body: form });
        const data = (await res.json().catch(() => ({})));
        if (!res.ok)
            throw new Error(translateApiDetail(data.detail) || t('backup.failed'));
        _setStatus(`<i class="fas fa-circle-check mr-1.5"></i>${escapeHtml(t('backup.upload_ok', { name: data.name || file.name }))}`, 'success');
        await loadBackupPanel();
    }
    catch (e) {
        _setStatus(`<i class="fas fa-triangle-exclamation mr-1.5"></i>${escapeHtml(e instanceof Error ? e.message : String(e))}`, 'error');
    }
}
if (typeof document !== 'undefined') {
    document.addEventListener('change', (e) => {
        const target = e.target;
        if (target instanceof HTMLInputElement && target.id === 'backup-encrypt-at-rest') {
            _updateEncryptionKeySection({ ..._cachedBackupSettings, encrypt_at_rest: target.checked }, _cachedEncryptionKeyStatus);
        }
    });
    document.addEventListener('change', (e) => {
        const target = e.target;
        if (!(target instanceof HTMLInputElement) || target.id !== 'backup-upload-input')
            return;
        const file = target.files?.[0];
        target.value = '';
        if (file)
            void uploadBackupArchive(file);
    });
}
