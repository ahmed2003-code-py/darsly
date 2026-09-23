import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';

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

export type Lang = 'ar' | 'en';

/**
 * Locales are fetched, not bundled.
 *
 * Both files used to be static imports, so every first paint shipped ~286 KB
 * of JSON — most of the initial chunk — and roughly half of it was a language
 * the reader had not chosen. On the 3G connections much of this app's audience
 * is on, that is the single most expensive thing in the bundle.
 *
 * Vite turns each dynamic import into its own chunk, so a visitor downloads
 * the language they are reading in and nothing else. The other one arrives
 * only if they switch, which is a deliberate act and a fine moment for a
 * network request.
 */
const LOADERS: Record<Lang, () => Promise<{ default: Record<string, unknown> }>> = {
  ar: () => import('./ar.json'),
  en: () => import('./en.json'),
};

const loaded = new Set<Lang>();

async function loadLocale(lang: Lang): Promise<void> {
  if (loaded.has(lang)) return;
  const mod = await LOADERS[lang]();
  i18n.addResourceBundle(lang, 'translation', mod.default, true, true);
  loaded.add(lang);
}

/**
 * Initialise with the reader's language already in hand.
 *
 * Awaited before React mounts (see main.tsx). Rendering first and filling the
 * strings in afterwards would show a frame of raw translation keys, which is
 * worse than the few milliseconds this costs.
 *
 * `fallbackLng` stays pointed at English even though English may not be
 * loaded. When it is absent i18next returns the key, which is what would have
 * happened with no fallback at all — so this costs nothing — and when the
 * reader has switched language at some point in the session it is there and
 * works. The two files are key-for-key identical today (2,649 each, verified),
 * so it should never fire; it is here for the day someone adds a key to one
 * file and not the other.
 */
export async function initI18n(): Promise<void> {
  const lng = storedLanguage() as Lang;
  await i18n.use(initReactI18next).init({
    resources: {},
    lng,
    fallbackLng: 'en',
    interpolation: { escapeValue: false },
  });
  await loadLocale(lng);
  i18n.changeLanguage(lng);
}

/** Keep <html lang/dir> in sync with the active language. */
function syncDocumentDir(lang: string) {
  document.documentElement.lang = lang;
  document.documentElement.dir = lang === 'ar' ? 'rtl' : 'ltr';
}
// Applied from storage rather than from i18n.language, because this now runs
// before init() has resolved — the document must already be pointing the right
// way for the very first paint, not one tick later.
syncDocumentDir(storedLanguage());
i18n.on('languageChanged', syncDocumentDir);

export async function setLanguage(lang: Lang): Promise<void> {
  localStorage.setItem(LANG_KEY, lang);
  // Kept in step so a visitor who switches inside the app and then opens a
  // teacher's published page reads it in the language they just chose.
  localStorage.setItem('darsly-lang', lang);
  // The chunk first: changing language before its strings exist paints one
  // frame of raw keys.
  await loadLocale(lang);
  await i18n.changeLanguage(lang); // languageChanged listener updates lang/dir
}

export default i18n;
