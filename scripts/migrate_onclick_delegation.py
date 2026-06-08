#!/usr/bin/env python3
"""Migrate inline onclick handlers to data-*-action delegation attributes."""

from __future__ import annotations

import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def migrate_config(content: str) -> str:
    rules: list[tuple[str, str]] = [
        (r'''onclick="openConfigSection\('([^']+)'\)"''', r'data-config-action="openSection" data-config-section="\1"'),
        (r'''onclick="switchConfigTab\('([^']+)'\)"''', r'data-config-action="switchTab" data-config-tab="\1"'),
        (r'''onclick="switchIntegrationSubtab\('([^']+)'\)"''', r'data-config-action="switchIntegrationSubtab" data-config-subtab="\1"'),
        (r'''onclick="selectNotifChannel\('([^']+)'\)"''', r'data-config-action="selectNotifChannel" data-config-channel="\1"'),
        (r'''onclick="selectNotifTransport\('([^']+)'\)"''', r'data-config-action="selectNotifTransport" data-config-transport="\1"'),
        (r'''onclick="saveConfig\(event\)"''', r'data-config-action="saveConfig"'),
        (r'''onclick="saveProfile\(event\)"''', r'data-config-action="saveProfile"'),
        (
            r'''onclick="if\(event\.target===this\)closeProfileCardMenu\(\)"''',
            r'data-config-action="closeProfileCardMenu" data-config-backdrop-dismiss="true"',
        ),
        (
            r'''onclick="if\(event\.target===this\)document\.getElementById\('integration-entry-modal'\)\.classList\.add\('hidden'\)"''',
            r'data-config-action="closeIntegrationEntryModal" data-config-backdrop-dismiss="true"',
        ),
        (r'''onclick="closeConfigSection\(\)"''', r'data-config-action="closeSection"'),
    ]

    fn_map = {
        'restartServer': 'restartServer',
        'showProfileEditor': 'showProfileEditor',
        'closeProfileCardMenu': 'closeProfileCardMenu',
        'addExtractionExample': 'addExtractionExample',
        'runConsolidationNow': 'runConsolidationNow',
        'testNotification': 'testNotification',
        'refreshNotifWsNativeStatus': 'refreshNotifWsNativeStatus',
        'detectAppWifi': 'detectAppWifi',
        'toggleAppBiometric': 'toggleAppBiometric',
        'requestMicPermission': 'requestMicPermission',
        'requestCameraPermission': 'requestCameraPermission',
        'requestLocationPermission': 'requestLocationPermission',
        'requestStoragePermission': 'requestStoragePermission',
        'clearAppCache': 'clearAppCache',
        'checkAddonUpdates': 'checkAddonUpdates',
        'updateAllAddons': 'updateAllAddons',
        'openSceneEditor': 'openSceneEditor',
        'openCreateAreaModal': 'openCreateAreaModal',
        'closeSceneEditor': 'closeSceneEditor',
        'addSceneEntry': 'addSceneEntry',
        'deleteSceneFromEditor': 'deleteSceneFromEditor',
        'saveScene': 'saveScene',
        'closeSceneEntityPicker': 'closeSceneEntityPicker',
        'closeAreaEditor': 'closeAreaEditor',
        'openAreaEntityPicker': 'openAreaEntityPicker',
        'deleteAreaFromEditor': 'deleteAreaFromEditor',
        'saveAreaFromEditor': 'saveAreaFromEditor',
        'closeAreaEntityPicker': 'closeAreaEntityPicker',
        'confirmAreaEntityPicker': 'confirmAreaEntityPicker',
        'closeAppLogModal': 'closeAppLogModal',
        'refreshAppLogs': 'refreshAppLogs',
        'closeInstallLogModal': 'closeInstallLogModal',
        'closeAddonConfigModal': 'closeAddonConfigModal',
        'checkAddonHealth': 'checkAddonHealth',
        'saveAddonConfig': 'saveAddonConfig',
        'closeProfileEditor': 'closeProfileEditor',
        'closeIntegrationConfigModal': 'closeIntegrationConfigModal',
        'copyWebhook': 'copyWebhook',
        'refreshComfyUICheckpoints': 'refreshComfyUICheckpoints',
        'refreshComfyUIWorkflows': 'refreshComfyUIWorkflows',
        'testComfyUIConnection': 'testComfyUIConnection',
        'testWhisperConnection': 'testWhisperConnection',
        'testPiperConnection': 'testPiperConnection',
    }

    for fn, action in fn_map.items():
        rules.append((rf'''onclick="{re.escape(fn)}\(\)"''', f'data-config-action="{action}"'))

    for pattern, repl in rules:
        content = re.sub(pattern, repl, content)
    return content


def migrate_memory(content: str) -> str:
    rules: list[tuple[str, str]] = [
        (r'''onclick="switchIntelligenceTab\('([^']+)'\)"''', r'data-memory-action="switchIntelligenceTab" data-memory-tab="\1"'),
        (r'''onclick="switchMemorySubtab\('([^']+)'\)"''', r'data-memory-action="switchMemorySubtab" data-memory-subtab="\1"'),
        (r'''onclick="changeMemPage\((-?\d+)\)"''', r'data-memory-action="changeMemPage" data-memory-delta="\1"'),
        (r'''onclick="switchAutomationEditorMode\('([^']+)'\)"''', r'data-memory-action="switchAutomationEditorMode" data-memory-mode="\1"'),
        (r'''onclick="addAutomationBuilderTrigger\('([^']+)'\)"''', r'data-memory-action="addAutomationBuilderTrigger" data-memory-kind="\1"'),
        (r'''onclick="addAutomationBuilderCondition\('([^']+)'\)"''', r'data-memory-action="addAutomationBuilderCondition" data-memory-kind="\1"'),
        (r'''onclick="addAutomationBuilderAction\('([^']+)'\)"''', r'data-memory-action="addAutomationBuilderAction" data-memory-kind="\1"'),
        (r'''onclick="loadMemoryEvents\(0\)"''', r'data-memory-action="loadMemoryEvents" data-memory-offset="0"'),
    ]

    fn_map = {
        'loadMemory': 'loadMemory',
        'deleteMemBulk': 'deleteMemBulk',
        'memLogPrevPage': 'memLogPrevPage',
        'memLogNextPage': 'memLogNextPage',
        'clearMemoryLog': 'clearMemoryLog',
        'openAutomationEditor': 'openAutomationEditor',
        'openBlueprintPicker': 'openBlueprintPicker',
        'loadAutomations': 'loadAutomations',
        'closeAutomationEditor': 'closeAutomationEditor',
        'loadAutomationEditorHistory': 'loadAutomationEditorHistory',
        'validateAutomationEditor': 'validateAutomationEditor',
        'testAutomationEditor': 'testAutomationEditor',
        'importAutomationYaml': 'importAutomationYaml',
        'exportAutomationYaml': 'exportAutomationYaml',
        'saveAutomationEditor': 'saveAutomationEditor',
        'closeBlueprintPicker': 'closeBlueprintPicker',
        'openBlueprintCreator': 'openBlueprintCreator',
        'importBlueprintYaml': 'importBlueprintYaml',
        'loadBlueprints': 'loadBlueprints',
        'backToBlueprintList': 'backToBlueprintList',
        'saveCreatedBlueprint': 'saveCreatedBlueprint',
        'deleteCurrentBlueprint': 'deleteCurrentBlueprint',
        'instantiateCurrentBlueprint': 'instantiateCurrentBlueprint',
        'addBlueprintCreatorInput': 'addBlueprintCreatorInput',
    }

    for fn, action in fn_map.items():
        rules.append((rf'''onclick="{re.escape(fn)}\(\)"''', f'data-memory-action="{action}"'))

    for pattern, repl in rules:
        content = re.sub(pattern, repl, content)
    return content


def migrate_smarthome(content: str) -> str:
    rules: list[tuple[str, str]] = [
        (r'''onclick="switchDerivedView\('([^']+)'\)"''', r'data-smarthome-action="switchDerivedView" data-smarthome-view="\1"'),
        (r'''onclick="switchDerivedBuilder\('([^']+)'\)"''', r'data-smarthome-action="switchDerivedBuilder" data-smarthome-builder="\1"'),
        (
            r'''onclick="if\(event\.target===this\)closeEntityDetailModal\(\)"''',
            r'data-smarthome-action="closeEntityDetailModal" data-smarthome-backdrop-dismiss="true"',
        ),
        (
            r'''onclick="event\.stopPropagation\(\);closeEntityDetailModal\(\)"''',
            r'data-smarthome-action="closeEntityDetailModal" data-smarthome-stop-propagation="true"',
        ),
        (r'''onclick="event\.stopPropagation\(\)"''', r'data-smarthome-stop-propagation="true"'),
    ]

    fn_map = {
        'closeAddDevicesModal': 'closeAddDevicesModal',
        'toggleAllAvailableDevices': 'toggleAllAvailableDevices',
        'confirmAddDevices': 'confirmAddDevices',
        'deleteDerivedFromModal': 'deleteDerivedFromModal',
        'closeDerivedModal': 'closeDerivedModal',
        'insertDerivedExpressionEntity': 'insertDerivedExpressionEntity',
        'reloadDerivedYaml': 'reloadDerivedYaml',
        'saveDerived': 'saveDerived',
        'closeRowActionsModal': 'closeRowActionsModal',
        'copyEntityIdFromRowActions': 'copyEntityIdFromRowActions',
        'closeAliasModal': 'closeAliasModal',
        'addAliasInput': 'addAliasInput',
        'saveAliasesFromModal': 'saveAliasesFromModal',
    }

    for fn, action in fn_map.items():
        rules.append((rf'''onclick="{re.escape(fn)}\(\)"''', f'data-smarthome-action="{action}"'))

    for pattern, repl in rules:
        content = re.sub(pattern, repl, content)
    return content


def main() -> int:
    targets = [
        (ROOT / 'templates/partials/config.html', migrate_config),
        (ROOT / 'templates/partials/memory.html', migrate_memory),
        (ROOT / 'templates/partials/smarthome.html', migrate_smarthome),
    ]
    for path, migrator in targets:
        original = path.read_text(encoding='utf-8')
        updated = migrator(original)
        if 'onclick=' in updated:
            remaining = sorted(set(re.findall(r'onclick="[^"]*"', updated)))
            print(f'WARN {path.name}: {len(remaining)} onclick remain:', file=sys.stderr)
            for item in remaining[:10]:
                print(f'  {item}', file=sys.stderr)
        path.write_text(updated, encoding='utf-8')
        print(f'Updated {path.name}')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
