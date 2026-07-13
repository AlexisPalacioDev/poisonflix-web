import { useSyncExternalStore } from 'react';
import { getLanguage, subscribeLanguage, type AppLanguage } from '../lib/domain/languageSettings';

/**
 * Reactive read of the current ES⇄EN app language (`lib/domain/
 * languageSettings.ts`), for components like the header's `LanguageChip`
 * that must re-render the moment `toggleLanguage()` flips it - mirrors
 * `useSyncExternalStore` over `subscribeSession` elsewhere in the app.
 */
export function useLanguage(): AppLanguage {
  return useSyncExternalStore(subscribeLanguage, getLanguage, getLanguage);
}
