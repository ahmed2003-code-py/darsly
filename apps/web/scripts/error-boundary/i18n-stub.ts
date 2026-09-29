import i18n from 'i18next';
import ar from '../../src/i18n/ar.json';
import en from '../../src/i18n/en.json';

/** The app's i18n fetches its locales; the harness needs them synchronously. */
const lang = (globalThis as { HARNESS_LANG?: string }).HARNESS_LANG ?? 'ar';
void i18n.init({
  lng: lang,
  initImmediate: false,
  resources: { ar: { translation: ar }, en: { translation: en } },
  interpolation: { escapeValue: false },
});
export default i18n;
