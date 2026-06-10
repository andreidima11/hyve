/** App bootstrap, native bridge, and lazy-module types. */

import type { ConfigFormElement } from './features_config.js';
import type { UserProfileResponse } from './dashboard.js';
import type { EventBindingHandler } from './event_bindings.js';

export type PermissionState = 'granted' | 'denied' | 'prompt' | string;

export type NativePermissionName = 'microphone' | 'camera' | 'location' | 'storage';

export interface HyveNativeConfig {
    externalUrl?: string;
    localUrl?: string;
    homeWifi?: string;
    biometricEnabled?: boolean;
    biometricAvailable?: boolean;
    serverMode?: string;
    currentSsid?: string;
    [key: string]: unknown;
}

export interface AppConfigFormData {
    externalUrl: string;
    localUrl: string;
    homeWifi: string;
    biometricEnabled: boolean;
}

export interface AppConfigSaveOptions {
    silent?: boolean;
}

export interface HyveSetupStatus {
    complete?: boolean;
    server_name?: string;
    default_language?: string;
    default_timezone?: string;
}

export type LazyModuleRecord = Record<string, unknown>;

export type LazyModuleLoader = () => Promise<LazyModuleRecord>;

export type DelegatedHandler = EventBindingHandler;

/** Wrap a typed handler for delegated event-binding maps. */
export type BindHandler = <A extends unknown[]>(
    fn: (...args: A) => unknown,
) => EventBindingHandler;

export interface BiometricToggleElement extends HTMLElement {
    __biometricOn?: boolean;
}

export type AppFormElement = ConfigFormElement | HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement;
