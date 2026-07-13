import { afterEach, describe, expect, it, vi } from 'vitest';

const STORAGE_KEY = 'poisonflix:adultPin';

// `adultUnlocked` is a module-level variable (see adultSettings.ts's file
// header) - `vi.resetModules()` + a fresh dynamic `import()` is how this
// suite simulates "a page reload" without actually reloading jsdom.
describe('adultSettings', () => {
  afterEach(() => {
    localStorage.removeItem(STORAGE_KEY);
    vi.resetModules();
  });

  it('defaults to PIN 6969 when nothing is persisted', async () => {
    const { DEFAULT_ADULT_PIN, getAdultPin } = await import('./adultSettings');
    expect(DEFAULT_ADULT_PIN).toBe('6969');
    expect(getAdultPin()).toBe('6969');
  });

  it('unlocks on the correct PIN', async () => {
    const { isAdultUnlocked, tryUnlock } = await import('./adultSettings');
    expect(isAdultUnlocked()).toBe(false);

    expect(tryUnlock('6969')).toBe(true);

    expect(isAdultUnlocked()).toBe(true);
  });

  it('rejects an incorrect PIN and stays locked', async () => {
    const { isAdultUnlocked, tryUnlock } = await import('./adultSettings');

    expect(tryUnlock('0000')).toBe(false);

    expect(isAdultUnlocked()).toBe(false);
  });

  it('the unlock flag resets on a fresh module load (never persisted)', async () => {
    const first = await import('./adultSettings');
    expect(first.tryUnlock('6969')).toBe(true);
    expect(first.isAdultUnlocked()).toBe(true);

    vi.resetModules();
    const second = await import('./adultSettings');

    expect(second.isAdultUnlocked()).toBe(false);
  });

  it('a changed PIN persists across a fresh module load', async () => {
    const first = await import('./adultSettings');
    first.setAdultPin('1234');
    expect(first.getAdultPin()).toBe('1234');

    vi.resetModules();
    const second = await import('./adultSettings');

    expect(second.getAdultPin()).toBe('1234');
    // The changed PIN, not the default, is what now unlocks.
    expect(second.tryUnlock('6969')).toBe(false);
    expect(second.tryUnlock('1234')).toBe(true);
  });

  it('re-locks via lockAdult without needing a reload', async () => {
    const { isAdultUnlocked, lockAdult, tryUnlock } = await import('./adultSettings');
    tryUnlock('6969');
    expect(isAdultUnlocked()).toBe(true);

    lockAdult();

    expect(isAdultUnlocked()).toBe(false);
  });

  it('subscribeAdultUnlocked notifies listeners on unlock and lock', async () => {
    const { lockAdult, subscribeAdultUnlocked, tryUnlock } = await import('./adultSettings');
    const listener = vi.fn();
    const unsubscribe = subscribeAdultUnlocked(listener);

    tryUnlock('6969');
    expect(listener).toHaveBeenLastCalledWith(true);

    lockAdult();
    expect(listener).toHaveBeenLastCalledWith(false);

    unsubscribe();
  });
});
