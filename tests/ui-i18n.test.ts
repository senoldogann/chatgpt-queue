import { describe, expect, it } from 'vitest';
import { CATALOGS, LOCALES, createTranslator, resolveLocale, translate, type MessageKey } from '../src/ui/i18n';
import { DEFAULT_UI_PREFERENCES, UI_PREFERENCES_KEY, UiPreferencesRepository } from '../src/ui/ui-preferences';
import { GUIDE_STEP_COUNT, GUIDE_STEPS, clampGuideIndex } from '../src/ui/guide';
import type { StorageAreaLike } from '../src/storage/queue-repository';

class MemoryStorage implements StorageAreaLike {
  data: Record<string, unknown> = {};
  async get(key: string) { return { [key]: this.data[key] }; }
  async set(values: Record<string, unknown>) { Object.assign(this.data, structuredClone(values)); }
}

describe('panel localisation', () => {
  it('ships a complete, non-empty catalog for every locale', () => {
    const englishKeys = Object.keys(CATALOGS.en).sort();
    expect(LOCALES).toEqual(['en', 'tr']);
    for (const locale of LOCALES) {
      const catalog = CATALOGS[locale];
      expect(Object.keys(catalog).sort()).toEqual(englishKeys);
      for (const [key, value] of Object.entries(catalog)) {
        expect(value.trim(), `${locale}:${key}`).not.toBe('');
      }
    }
  });

  it('translates from the requested locale and interpolates parameters', () => {
    expect(translate('tr', 'status.running')).toBe('Çalışıyor');
    expect(translate('en', 'context.pressure', { percent: 61, capacity: '262K', estimated: '160K', turns: 12, source: 'page' }))
      .toContain('12 visible turns');
    expect(translate('tr', 'notice.ownedByOtherTab', { tabId: 7 })).toContain('7');
    expect(translate('tr', 'workflow.required')).toBe('Zorunlu');
    expect(translate('tr', 'workflow.input.diff.help')).toContain('git diff');
    expect(translate('tr', 'tab.queue')).toBe('Sıra');
    expect(translate('tr', 'tab.workflow')).toBe('İş Akışı');
    expect(translate('tr', 'tab.system')).toBe('Sistem');
    expect(translate('tr', 'timer.active')).toBe('Aktif süre');
  });

  it('leaves an unknown placeholder intact instead of dropping it', () => {
    expect(translate('en', 'workflow.progress', { done: 1 })).toBe('1 / {total}');
  });

  it('falls back to the key itself rather than throwing on an unknown key', () => {
    expect(translate('tr', 'not.a.real.key' as MessageKey)).toBe('not.a.real.key');
    expect(createTranslator('tr')('guide.title')).toBe('Bu panel nasıl kullanılır');
  });

  it('resolves auto against the browser language and honours an explicit choice', () => {
    expect(resolveLocale('auto', 'tr-TR')).toBe('tr');
    expect(resolveLocale('auto', 'en-US')).toBe('en');
    expect(resolveLocale('auto', 'de-DE')).toBe('en');
    expect(resolveLocale('en', 'tr-TR')).toBe('en');
    expect(resolveLocale('tr', 'en-US')).toBe('tr');
  });
});

describe('usage guide catalog', () => {
  it('resolves every step to a non-empty title and body in both locales', () => {
    expect(GUIDE_STEP_COUNT).toBeGreaterThan(0);
    for (const step of GUIDE_STEPS) {
      for (const locale of LOCALES) {
        expect(translate(locale, step.title).trim(), `${locale}:${step.id}`).not.toBe('');
        expect(translate(locale, step.body).trim(), `${locale}:${step.id}`).not.toBe('');
      }
    }
  });

  it('clamps navigation to the available steps', () => {
    expect(clampGuideIndex(-4)).toBe(0);
    expect(clampGuideIndex(GUIDE_STEP_COUNT + 5)).toBe(GUIDE_STEP_COUNT - 1);
    expect(clampGuideIndex(2)).toBe(2);
    expect(clampGuideIndex(Number.NaN)).toBe(0);
  });
});

describe('UiPreferencesRepository', () => {
  it('defaults to auto-detected language when nothing is stored', async () => {
    expect(await new UiPreferencesRepository(new MemoryStorage()).get()).toEqual(DEFAULT_UI_PREFERENCES);
  });

  it('round-trips an explicit locale', async () => {
    const storage = new MemoryStorage();
    const repo = new UiPreferencesRepository(storage);
    await repo.setLocale('tr');
    expect(await repo.get()).toEqual({ version: 1, locale: 'tr' });
    expect(storage.data[UI_PREFERENCES_KEY]).toEqual({ version: 1, locale: 'tr' });
  });

  it('ignores a corrupt or out-of-range persisted value', async () => {
    const storage = new MemoryStorage();
    storage.data[UI_PREFERENCES_KEY] = { version: 1, locale: 'de' };
    expect(await new UiPreferencesRepository(storage).get()).toEqual(DEFAULT_UI_PREFERENCES);

    storage.data[UI_PREFERENCES_KEY] = { version: 99, locale: 'tr' };
    expect(await new UiPreferencesRepository(storage).get()).toEqual(DEFAULT_UI_PREFERENCES);
  });
});
