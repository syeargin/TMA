import { InjectionToken } from '@angular/core';

/** Per-environment settings from /config.json (written by the deploy workflow). */
export interface AppConfig {
  env?: string;
  commit?: string;
  region?: string;
  userPoolId?: string;
  userPoolClientId?: string;
  apiUrl?: string;
  wsUrl?: string;
}

export const APP_CONFIG = new InjectionToken<AppConfig>('APP_CONFIG');

export async function loadConfig(): Promise<AppConfig> {
  try {
    const res = await fetch('/config.json', { cache: 'no-store' });
    return res.ok ? ((await res.json()) as AppConfig) : {};
  } catch {
    return {};
  }
}
