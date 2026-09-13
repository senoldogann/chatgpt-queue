import type { StorageAreaLike } from '../storage/queue-repository';
import { LOCALES, type LocalePreference } from './i18n';

export const UI_PREFERENCES_KEY = 'chatgptQueueUiPreferences';

export interface UiPreferences {
  version: 1;
  locale: LocalePreference;
}

export const DEFAULT_UI_PREFERENCES: UiPreferences = { version: 1, locale: 'auto' };

const isLocalePreference = (value: unknown): value is LocalePreference =>
  value === 'auto' || (typeof value === 'string' && (LOCALES as readonly string[]).includes(value));

/**
 * Durable UI preferences.
 *
 * Kept in `chrome.storage.local` next to the rest of the extension state so the chosen language is
 * shared by every open ChatGPT tab instead of being per-tab.
 */
export class UiPreferencesRepository {
  constructor(private readonly storage: StorageAreaLike) {}

  async get(): Promise<UiPreferences> {
    const raw = (await this.storage.get(UI_PREFERENCES_KEY))[UI_PREFERENCES_KEY];
    if (!raw || typeof raw !== 'object') return { ...DEFAULT_UI_PREFERENCES };
    const candidate = raw as Partial<UiPreferences>;
    if (candidate.version !== 1 || !isLocalePreference(candidate.locale)) return { ...DEFAULT_UI_PREFERENCES };
    return { version: 1, locale: candidate.locale };
  }

  async setLocale(locale: LocalePreference): Promise<void> {
    const next: UiPreferences = { version: 1, locale: isLocalePreference(locale) ? locale : 'auto' };
    await this.storage.set({ [UI_PREFERENCES_KEY]: next });
  }
}
