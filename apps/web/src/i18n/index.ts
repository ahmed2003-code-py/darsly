import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import ar from './ar.json';
import en from './en.json';

/**
 * The one key the language is stored under.
 *
 * A generated academy site is served from this same origin and has always
 * written its own toggle to `darsly_lang`, while the app read `darsly-lang` — a
 * hyphen against an underscore. So a visitor who read a teacher's page in
 * English and clicked through to sign in was handed an Arabic form, because the
 * two halves of the product were keeping the same preference in two places.
 *
 * The app moves to the site's key rather than the other way round: every page
 * already published writes it, so the two agree immediately and no teacher has
 * to publish again for it to take effect.
 */
const LANG_KEY = 'darsly_lang';

function storedLanguage(): string {
  const carried = localStorage.getItem(LANG_KEY);
  if (carried === 'ar' || carried === 'en') return carried;
  // One-time move of anyone who last set their language inside the app.
  const legacy = localStorage.getItem('darsly-lang');
  if (legacy === 'ar' || legacy === 'en') {
    localStorage.setItem(LANG_KEY, legacy);
    return legacy;
  }
  return 'ar';
}

// Arabic-first with English fallback. Direction follows the active language.
i18n.use(initReactI18next).init({
  resources: { ar: { translation: ar }, en: { translation: en } },
  lng: storedLanguage(),
  fallbackLng: 'en',
  interpolation: { escapeValue: false },
});

/** Keep <html lang/dir> in sync with the active language. */
function syncDocumentDir(lang: string) {
  document.documentElement.lang = lang;
  document.documentElement.dir = lang === 'ar' ? 'rtl' : 'ltr';
}
// Apply immediately on load (fixes the sidebar staying on the RTL side when the
// stored language is English) and on every subsequent change.
syncDocumentDir(i18n.language);
i18n.on('languageChanged', syncDocumentDir);

export function setLanguage(lang: 'ar' | 'en') {
  localStorage.setItem(LANG_KEY, lang);
  // Kept in step so a visitor who switches inside the app and then opens a
  // teacher's published page reads it in the language they just chose.
  localStorage.setItem('darsly-lang', lang);
  i18n.changeLanguage(lang); // languageChanged listener updates lang/dir
}

export default i18n;
