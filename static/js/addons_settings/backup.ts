/**
 * Settings → Backup & restore hub panel.
 */
import { apiCall } from '../api.js';
import { t, translateApiDetail } from '../lang/index.js';
import { showConfirm, escapeHtml } from '../utils.js';
import { isExplicitNonAdmin } from '../user_context.js';

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
    remote_enabled?: boolean;
    remote_configured?: boolean;
}

interface BackupRemoteArchiveRow {
    name: string;
    remote_key?: string;
    size: number;
    modified_at?: string | null;
    provider?: string;
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
    if (refetch) refetch.checked = !!settings.refetch_addons;
    const encrypt = _el<HTMLInputElement>('backup-encrypt-at-rest');
    if (encrypt) encrypt.checked = !!settings.encrypt_at_rest;

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
    _el('backup-remote-s3-fields')?.classList.toggle('hidden', provider !== 's3');
    _el('backup-remote-sftp-fields')?.classList.toggle('hidden', provider !== 'sftp');
}

function _settingsFromForm(): BackupSettings {
    const provider = _el<HTMLSelectElement>('backup_remote_provider')?.value || 'none';
    return {
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
        remote: {
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
        },
    };
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
        _setMaintenanceBanner(!!data.maintenance, data.maintenance_reason || '');
        _applySettings(data.settings);
        _renderArchives(data.archives || []);
        const showRemote = !!(data.remote_enabled && data.remote_configured);
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
    _setStatus(`<i class="fas fa-spinner fa-spin mr-1.5"></i>${escapeHtml(t('backup.verifying'))}`, 'info');
    try {
        const res = await apiCall('/api/backup/verify', { method: 'POST', body: { path } });
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

export async function restoreBackup(path: string): Promise<void> {
    if (!path) return;
    if (!(await showConfirm(t('backup.confirm_restore')))) return;
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
            },
        });
        const data = (await res.json().catch(() => ({}))) as {
            detail?: unknown;
            restored_files?: number;
            pre_restore_backup?: string | null;
        };
        if (!res.ok) throw new Error(translateApiDetail(data.detail) || t('backup.failed'));
        let msg = t('backup.restore_ok', { files: data.restored_files || 0 });
        if (data.pre_restore_backup) msg += ` ${t('backup.pre_restore_created')}`;
        _setStatus(`<i class="fas fa-circle-check mr-1.5"></i>${escapeHtml(msg)}`, 'success');
        await loadBackupPanel();
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
    _setStatus(`<i class="fas fa-spinner fa-spin mr-1.5"></i>${escapeHtml(t('backup.rollbacking'))}`, 'info');
    try {
        const res = await apiCall('/api/backup/rollback', { method: 'POST', body: { path } });
        const data = (await res.json().catch(() => ({}))) as {
            detail?: unknown;
            restored_files?: number;
        };
        if (!res.ok) throw new Error(translateApiDetail(data.detail) || t('backup.failed'));
        _setStatus(
            `<i class="fas fa-circle-check mr-1.5"></i>${escapeHtml(t('backup.rollback_ok', { files: data.restored_files || 0 }))}`,
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

function _intervalLabel(val: string): string {
    const key = ({
        never: 'updates.interval_never',
        daily: 'updates.interval_daily',
        weekly: 'updates.interval_weekly',
        monthly: 'updates.interval_monthly',
    } as Record<string, string>)[val];
    return key ? t(key) : val;
}

let _backupDropdownBound = false;

if (typeof document !== 'undefined' && !_backupDropdownBound) {
    _backupDropdownBound = true;
    document.addEventListener('click', (e) => {
        const dd = document.getElementById('backup_schedule_dropdown');
        if (!dd) return;
        const target = e.target;
        if (!(target instanceof Element)) return;
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
            const value = (opt as HTMLElement).dataset.value || '';
            const labelKey = (opt as HTMLElement).dataset.labelKey;
            const label = labelKey ? t(labelKey) : (opt.textContent || '').trim();
            setBackupScheduleInterval(value, label);
            return;
        }
        if (!dd.contains(target)) dd.dataset.open = 'false';
    });
}

export function setBackupScheduleInterval(value: string, label?: string): void {
    const dd = document.getElementById('backup_schedule_dropdown');
    const hidden = document.getElementById('backup_schedule_interval') as HTMLInputElement | null;
    const lbl = label || _intervalLabel(value);
    if (dd) {
        dd.dataset.open = 'false';
        const valueEl = dd.querySelector('.dashboard-custom-select__value');
        if (valueEl) valueEl.textContent = lbl;
        dd.querySelectorAll('.dashboard-custom-select__option').forEach((o) => {
            const opt = o as HTMLElement;
            opt.dataset.selected = opt.dataset.value === value ? 'true' : 'false';
        });
    }
    if (hidden) hidden.value = value;
}

export function syncBackupScheduleDropdown(): void {
    const hidden = document.getElementById('backup_schedule_interval') as HTMLInputElement | null;
    if (!hidden) return;
    setBackupScheduleInterval(hidden.value || 'never');
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
        };
        if (!res.ok) throw new Error(translateApiDetail(data.detail) || t('backup.failed'));
        let msg = t('backup.restore_ok', { files: data.restored_files || 0 });
        if (data.pre_restore_backup) msg += ` ${t('backup.pre_restore_created')}`;
        _setStatus(`<i class="fas fa-circle-check mr-1.5"></i>${escapeHtml(msg)}`, 'success');
        await loadBackupPanel();
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
        if (!(target instanceof HTMLInputElement) || target.id !== 'backup-upload-input') return;
        const file = target.files?.[0];
        target.value = '';
        if (file) void uploadBackupArchive(file);
    });
}
