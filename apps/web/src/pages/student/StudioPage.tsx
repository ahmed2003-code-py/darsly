import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api } from '../../lib/api';
import {
  applyStudio,
  playActivation,
  previewStudio,
  rememberAcademy,
  restoreStudio,
} from '../../lib/studio';
import { CardGridSkeleton, ErrorNote, PageHeader, ProgressBar, Spinner } from '../../components/ui';

/**
 * My Studio.
 *
 * The teacher customises their academy; this is where the student customises
 * their Darsly. It is deliberately not a settings page — the shape of it is a
 * profile, a collection and a shop, because that is what makes somebody want to
 * come back to it.
 *
 * Everything shown here is decided by the server: what something costs, whether
 * it can be bought, whether it is owned, whether the level is high enough. This
 * screen draws those answers and never computes them, which is what keeps a
 * hidden button from being the only thing between a student and a legendary
 * theme.
 */

type Tab = 'style' | 'collection' | 'shop';
const TABS: Tab[] = ['style', 'collection', 'shop'];

/**
 * Three decisions, not eight.
 *
 * A theme now brings its own button and card and navigation shapes, so picking
 * one is the whole look. The shape slots still exist for anyone who wants to
 * argue with a theme, but they sit behind a disclosure rather than as four more
 * things a fourteen-year-old has to have an opinion about.
 */
const CATEGORIES = [
  'THEME', 'ACCENT', 'BUTTON_STYLE', 'CARD_STYLE', 'NAV_STYLE', 'AVATAR', 'FRAME', 'EFFECT',
] as const;
type Category = (typeof CATEGORIES)[number];

const PRIMARY: Category[] = ['THEME', 'ACCENT', 'AVATAR', 'FRAME'];
const ADVANCED: Category[] = ['BUTTON_STYLE', 'CARD_STYLE', 'NAV_STYLE', 'EFFECT'];

const SLOT: Record<Category, string> = {
  THEME: 'themeKey',
  ACCENT: 'accentKey',
  BUTTON_STYLE: 'buttonKey',
  CARD_STYLE: 'cardKey',
  NAV_STYLE: 'navKey',
  AVATAR: 'avatarKey',
  FRAME: 'frameKey',
  EFFECT: 'effectKey',
};

const RARITY_TONE: Record<string, string> = {
  COMMON: 'bg-surface-container-high text-on-surface-variant',
  RARE: 'bg-secondary-container text-on-secondary-container',
  EPIC: 'bg-primary-fixed text-on-primary-fixed-variant',
  LEGENDARY: 'bg-student-gold-soft text-student-gold-ink',
};

/** A palette to pick from, so choosing a colour is not a blank canvas. */
const SWATCHES = [
  '#4a32c9', '#7c3aed', '#2563eb', '#0d9488', '#059669',
  '#ca8a04', '#ea580c', '#be123c', '#db2777', '#475569',
];

interface StudioItem {
  id: string;
  key: string;
  category: Category;
  rarity: string;
  name: { ar: string; en: string };
  description: { ar: string; en: string };
  config: Record<string, unknown>;
  costCoins: number;
  requiredLevel: number;
  requiredAchievement: string | null;
  owned: boolean;
  purchasable: boolean;
  levelLocked: boolean;
  achievementLocked: boolean;
  /** What the app would look like wearing this — derived on the server. */
  preview?: unknown;
}

export default function StudioPage() {
  const { t, i18n } = useTranslation();
  const ar = i18n.language !== 'en';
  const qc = useQueryClient();
  const [tab, setTab] = useState<Tab>('style');
  const [category, setCategory] = useState<Category>('THEME');
  const [advanced, setAdvanced] = useState(false);
  const [previewing, setPreviewing] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<StudioItem | null>(null);
  const [justBought, setJustBought] = useState<string | null>(null);

  const { data, isLoading, error } = useQuery({
    queryKey: ['studio'],
    queryFn: async () => (await api.get('/student/studio')).data,
  });

  // What is equipped is the truth the rest of the app runs on, so it is applied
  // as soon as it lands rather than only on the next full load.
  useEffect(() => {
    if (data?.theme && !previewing) applyStudio(data.theme);
  }, [data?.theme, previewing]);

  // Leaving the page mid-preview must not leave the preview on.
  useEffect(() => () => restoreStudio(), []);

  const after = (theme: unknown) => {
    applyStudio(theme);
    qc.invalidateQueries({ queryKey: ['studio'] });
    qc.invalidateQueries({ queryKey: ['gamification'] });
  };

  const equip = useMutation({
    mutationFn: async (key: string) => (await api.post('/student/studio/equip', { key })).data,
    onSuccess: (d) => {
      setPreviewing(null);
      // A bought theme replaces a teacher's look; the branding layer has to be
      // told, or it would keep repainting the academy over it.
      if (d.equipped?.academyId == null) rememberAcademy(null);
      after(d.theme);
      playActivation();
    },
  });
  const unlock = useMutation({
    mutationFn: async (key: string) => (await api.post('/student/studio/unlock', { key })).data,
    onSuccess: (_d, key) => {
      setConfirming(null);
      // Owned, not worn. Two different things, and a student who just spent a
      // hundred coins should be the one who decides the app changes.
      setJustBought(key);
      qc.invalidateQueries({ queryKey: ['studio'] });
      qc.invalidateQueries({ queryKey: ['gamification'] });
    },
  });
  const accent = useMutation({
    mutationFn: async (hex: string) => (await api.post('/student/studio/accent', { hex })).data,
    onSuccess: (d) => after(d.theme),
  });
  /**
   * Wear a teacher's colours.
   *
   * The academy palette is painted by the branding layer, not by the Studio, so
   * this records the choice and lets that layer repaint — which is why there is
   * no theme to apply here.
   */
  const equipAcademy = useMutation({
    mutationFn: async (academyId: string) =>
      (await api.post('/student/studio/equip-academy', { academyId })).data,
    onSuccess: (d, academyId) => {
      setPreviewing(null);
      rememberAcademy(academyId);
      after(d.theme);
    },
  });

  const reset = useMutation({
    mutationFn: async () => (await api.delete('/student/studio/customization')).data,
    onSuccess: (d) => {
      setPreviewing(null);
      rememberAcademy(null);
      after(d.theme);
    },
  });

  const items: StudioItem[] = data?.items ?? [];
  const byCategory = useMemo(() => {
    const map = new Map<Category, StudioItem[]>();
    for (const it of items) {
      if (!map.has(it.category)) map.set(it.category, []);
      map.get(it.category)!.push(it);
    }
    return map;
  }, [items]);

  const equippedKey = (cat: Category): string | null => data?.equipped?.[SLOT[cat]] ?? null;

  // The premium theme nobody owns yet. One at most: a shop that features
  // everything features nothing.
  const featured = items.find(
    (i) => i.category === 'THEME' && i.rarity === 'LEGENDARY' && !i.owned,
  );
  const gridItems = (byCategory.get(category) ?? []).filter((i) => i.key !== featured?.key);

  /**
   * Try something on.
   *
   * Purely local, and never a request: previewing must not be able to change
   * anything, which is easiest to guarantee when there is nothing to change.
   * The tokens are the ones the server already sent with the catalogue.
   */
  function preview(item: StudioItem) {
    if (previewing === item.key) {
      setPreviewing(null);
      restoreStudio();
      return;
    }
    setPreviewing(item.key);
    previewStudio(previewTheme(data, item));
  }

  if (isLoading) {
    return (
      <div className="mx-auto max-w-container px-6 py-8 sm:px-8">
        <PageHeader title={t('myStudio.title')} subtitle={t('myStudio.subtitle')} />
        <CardGridSkeleton count={6} />
      </div>
    );
  }
  if (error || !data) {
    return (
      <div className="mx-auto max-w-container px-6 py-8 sm:px-8">
        <PageHeader title={t('myStudio.title')} subtitle={t('myStudio.subtitle')} />
        <ErrorNote error={error} />
      </div>
    );
  }

  const b = data.balance;
  const owned = items.filter((i) => i.owned);
  const shop = items.filter((i) => !i.owned);

  return (
    <div className="mx-auto max-w-container px-6 py-8 sm:px-8">
      <PageHeader title={t('myStudio.title')} subtitle={t('myStudio.subtitle')} />

      {previewing && (
        <div className="mb-5 flex flex-wrap items-center gap-3 rounded-2xl border border-student-accent-border bg-student-accent-soft px-4 py-3">
          <span className="material-symbols-outlined text-student-accent-ink">visibility</span>
          <p className="me-auto text-sm font-bold text-student-accent-ink">{t('myStudio.previewing')}</p>
          <button
            className="studio-btn rounded-xl border border-outline-variant px-4 py-2 text-sm font-bold"
            onClick={() => {
              setPreviewing(null);
              restoreStudio();
            }}
          >
            {t('myStudio.exitPreview')}
          </button>
        </div>
      )}

      <ProfileCard data={data} t={t} ar={ar} />

      {/* Tabs */}
      <div className="scroll-x mb-6 -mx-6 mt-6 px-6 sm:mx-0 sm:px-0">
        <div className="inline-flex min-w-full gap-1 rounded-full bg-surface-container-high p-1">
          {TABS.map((k) => (
            <button
              key={k}
              onClick={() => setTab(k)}
              className={`studio-btn whitespace-nowrap rounded-full px-4 py-2 text-sm font-bold transition ${
                tab === k
                  ? 'studio-active bg-surface-container-lowest text-student-accent-ink shadow-hairline'
                  : 'text-on-surface-variant'
              }`}
            >
              {t(`myStudio.tab.${k}`)}
            </button>
          ))}
        </div>
      </div>

      {tab === 'style' && (
        <>
          <CategoryBar
            category={category}
            setCategory={setCategory}
            t={t}
            counts={byCategory}
            advanced={advanced}
            toggleAdvanced={() => {
              const next = !advanced;
              setAdvanced(next);
              if (!next && ADVANCED.includes(category)) setCategory('THEME');
            }}
          />
          {/* A single premium theme deserves more than one cell of a grid. It
              gets the width, a taller preview and the price in full — and it
              stops being featured the moment it is owned, because then it is
              just one of the things you have. */}
          {category === 'THEME' && featured && (
            <FeaturedTheme
              item={featured}
              coins={b.coins}
              ar={ar}
              t={t}
              previewing={previewing === featured.key}
              onPreview={() => preview(featured)}
              onUnlock={() => setConfirming(featured)}
              busy={unlock.isPending}
            />
          )}
          {category === 'THEME' && (data?.academyThemes?.length ?? 0) > 0 && (
            <AcademyThemes
              rows={data.academyThemes}
              onEquip={(id) => equipAcademy.mutate(id)}
              busy={equipAcademy.isPending}
              t={t}
            />
          )}
          {category === 'ACCENT' && (
            <AccentPicker
              current={data.equipped?.accentHex ?? null}
              onPick={(hex) => accent.mutate(hex)}
              pending={accent.isPending}
              t={t}
            />
          )}
          {/* The featured theme is already on the page in full; leaving it in the
              grid listed it twice, the second time under a heading about
              teachers. A category whose only item is featured above is not an
              empty category, so it says nothing rather than "nothing here". */}
          {!(category === 'THEME' && featured && gridItems.length === 0) && (
          <ItemGrid
            items={gridItems}
            heading={category === 'THEME' ? t('myStudio.storeThemes') : undefined}
            hint={category === 'THEME' ? t('myStudio.storeThemesHint') : undefined}
            equippedKey={equippedKey(category)}
            previewing={previewing}
            ar={ar}
            t={t}
            onPreview={preview}
            onEquip={(k) => equip.mutate(k)}
            onUnlock={(item) => setConfirming(item)}
            busy={equip.isPending || unlock.isPending}
          />
          )}
          <div className="mt-6">
            <button
              className="studio-btn rounded-xl border border-outline-variant px-5 py-2.5 text-sm font-bold text-on-surface-variant transition hover:border-error hover:text-error"
              disabled={reset.isPending}
              onClick={() => window.confirm(t('myStudio.resetConfirm')) && reset.mutate()}
            >
              {reset.isPending ? t('common.saving') : t('myStudio.reset')}
            </button>
            <p className="mt-2 text-sm text-on-surface-variant">{t('myStudio.resetHint')}</p>
          </div>
        </>
      )}

      {tab === 'collection' && (
        <ItemGrid
          items={owned}
          equippedKey={null}
          equippedMap={data.equipped}
          previewing={previewing}
          ar={ar}
          t={t}
          onPreview={preview}
          onEquip={(k) => equip.mutate(k)}
          onUnlock={(item) => setConfirming(item)}
          busy={equip.isPending || unlock.isPending}
          empty={t('myStudio.emptyCollection')}
        />
      )}

      {tab === 'shop' && (
        <ItemGrid
          items={shop}
          equippedKey={null}
          previewing={previewing}
          ar={ar}
          t={t}
          onPreview={preview}
          onEquip={(k) => equip.mutate(k)}
          onUnlock={(item) => setConfirming(item)}
          busy={equip.isPending || unlock.isPending}
          empty={t('myStudio.emptyShop')}
        />
      )}

      <ErrorNote error={unlock.error ?? equip.error ?? accent.error ?? reset.error} />

      {justBought && (
        <BoughtDialog
          item={items.find((i) => i.key === justBought)}
          ar={ar}
          t={t}
          pending={equip.isPending}
          onClose={() => setJustBought(null)}
          onEquip={() => {
            equip.mutate(justBought);
            setJustBought(null);
          }}
        />
      )}

      {confirming && (
        <UnlockDialog
          item={confirming}
          coins={b.coins}
          ar={ar}
          t={t}
          pending={unlock.isPending}
          onCancel={() => setConfirming(null)}
          onConfirm={() => unlock.mutate(confirming.key)}
        />
      )}
    </div>
  );
}

/* ── Pieces ────────────────────────────────────────────────────────────────── */

function ProfileCard({ data, t, ar }: { data: any; t: any; ar: boolean }) {
  const b = data.balance;
  const name = data.student.name as string;
  // Two rows on a phone and one on a desktop: identity and progress first,
  // the three numbers under them. Squeezing all of it onto one line is what
  // turned the name into a single letter.
  return (
    <div className="studio-card card p-5 sm:p-6">
      <div className="flex items-center gap-4">
        <span className="studio-frame grid h-16 w-16 shrink-0 place-items-center overflow-hidden rounded-full bg-student-accent-soft font-heading text-2xl font-extrabold text-student-accent-ink">
          {data.student.avatarUrl ? (
            <img src={data.student.avatarUrl} alt="" className="h-full w-full object-cover" />
          ) : (
            (name?.trim()?.charAt(0) ?? '؟')
          )}
        </span>
        <div className="min-w-0 flex-1">
          <p className="truncate font-heading text-lg font-extrabold">{name}</p>
          <p className="truncate text-sm text-on-surface-variant">
            {t('myStudio.levelLine', { level: b.level, name: ar ? b.levelName.ar : b.levelName.en })}
          </p>
        </div>
      </div>

      <div className="mt-4">
        <ProgressBar pct={b.levelPct ?? 0} tone="gold" />
        <p className="mt-1.5 text-sm text-on-surface-variant">
          {t('myStudio.toNext', { xp: Math.max(0, (b.xpForNext ?? 0) - (b.xpIntoLevel ?? 0)) })}
        </p>
      </div>

      <div className="mt-4 grid grid-cols-3 gap-3 border-t border-outline-variant pt-4">
        <Stat icon="star" value={b.xp} label={t('myStudio.xp')} />
        <Stat icon="paid" value={b.coins} label={t('myStudio.coins')} />
        <Stat icon="local_fire_department" value={data.student.streak} label={t('myStudio.streak')} tone="streak" />
      </div>
    </div>
  );
}

function Stat({
  icon,
  value,
  label,
  tone,
}: {
  icon: string;
  value: number;
  label: string;
  // The streak is a habit, not a winning — the same split the level card makes.
  tone?: 'streak';
}) {
  return (
    <span className="text-center">
      <span
        className={`material-symbols-outlined block text-[22px] ${
          tone === 'streak' ? 'text-student-secondary-ink' : 'text-student-gold-ink'
        }`}
      >
        {icon}
      </span>
      <span className="block font-heading text-lg font-extrabold tabular-nums">{value}</span>
      <span className="block text-xs text-on-surface-variant">{label}</span>
    </span>
  );
}

/**
 * Bought, and not yet worn.
 *
 * Purchase and activation are separate on purpose: owning something and having
 * it on are different states, and a hundred coins is enough that the change
 * should be the student's to make rather than a side effect.
 */
function BoughtDialog({
  item,
  ar,
  t,
  pending,
  onClose,
  onEquip,
}: {
  item?: StudioItem;
  ar: boolean;
  t: any;
  pending: boolean;
  onClose: () => void;
  onEquip: () => void;
}) {
  if (!item) return null;
  const cfg = item.config as { accent?: string; secondary?: string };
  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/60 p-4" role="dialog" aria-modal="true">
      <div className="s-pop-in w-full max-w-sm rounded-2xl bg-surface-container-lowest p-6 text-center shadow-modal">
        <span
          className="s-shine mx-auto grid h-16 w-16 place-items-center rounded-full"
          style={{
            background: `linear-gradient(135deg, ${cfg.accent ?? '#dc2626'}, ${cfg.secondary ?? '#ffb95f'})`,
          }}
        >
          <span className="material-symbols-outlined text-[30px] text-white">emoji_events</span>
        </span>
        <p className="mt-4 font-heading text-xl font-extrabold">{t('myStudio.bought')}</p>
        <p className="mt-1 text-sm text-on-surface-variant">
          {t('myStudio.boughtHint', { name: ar ? item.name.ar : item.name.en })}
        </p>
        <div className="mt-5 flex gap-2">
          <button
            className="studio-btn flex-1 rounded-xl border border-outline-variant px-4 py-2.5 font-bold"
            onClick={onClose}
          >
            {t('myStudio.later')}
          </button>
          <button
            className="studio-btn flex-1 rounded-xl bg-student-accent px-4 py-2.5 font-bold text-on-student-accent transition hover:bg-student-accent-hover disabled:opacity-60"
            disabled={pending}
            onClick={onEquip}
          >
            {t('myStudio.activateNow')}
          </button>
        </div>
      </div>
    </div>
  );
}

/**
 * One premium theme, given the room to sell itself.
 *
 * Everything on it comes from the server: the price, whether it can be bought,
 * whether the level is high enough. The card draws those answers and computes
 * none of them.
 */
function FeaturedTheme({
  item,
  coins,
  ar,
  t,
  previewing,
  onPreview,
  onUnlock,
  busy,
}: {
  item: StudioItem;
  coins: number;
  ar: boolean;
  t: any;
  previewing: boolean;
  onPreview: () => void;
  onUnlock: () => void;
  busy: boolean;
}) {
  const cfg = item.config as {
    accent?: string;
    accentDark?: string;
    secondary?: string;
    gold?: string;
    pattern?: string;
    surfaces?: { background?: string; surface?: string; ink?: string };
  };
  const locked = item.levelLocked || item.achievementLocked;
  const enough = coins >= item.costCoins;

  return (
    <article className="studio-card studio-pop card mb-6 overflow-hidden p-0">
      <div className="relative">
        <ThemePreview
          accent={cfg.accent ?? '#c8102e'}
          accentDark={cfg.accentDark}
          gold={cfg.gold ?? cfg.secondary}
          surfaces={cfg.surfaces}
          pattern={cfg.pattern}
          tall
          sheen
        />
        <span className="absolute end-3 top-3 rounded-full bg-black/45 px-2.5 py-1 text-[11px] font-bold text-white backdrop-blur">
          {t(`myStudio.rarity.${item.rarity}`)}
        </span>
      </div>

      <div className="p-5">
        <p className="font-heading text-xl font-extrabold">{ar ? item.name.ar : item.name.en}</p>
        <p className="mt-1 text-sm text-on-surface-variant">
          {ar ? item.description.ar : item.description.en}
        </p>

        {/* The three numbers somebody about to spend wants in front of them. */}
        <dl className="mt-4 grid grid-cols-3 gap-3 rounded-xl bg-surface-container-low p-3 text-center">
          <div>
            <dt className="text-xs text-on-surface-variant">{t('myStudio.price')}</dt>
            <dd className="font-heading font-extrabold tabular-nums">{item.costCoins}</dd>
          </div>
          <div>
            <dt className="text-xs text-on-surface-variant">{t('myStudio.yourCoins')}</dt>
            <dd className="font-heading font-extrabold tabular-nums">{coins}</dd>
          </div>
          <div>
            <dt className="text-xs text-on-surface-variant">{t('myStudio.after')}</dt>
            <dd
              className={`font-heading font-extrabold tabular-nums ${enough ? '' : 'text-error'}`}
            >
              {coins - item.costCoins}
            </dd>
          </div>
        </dl>

        <div className="mt-4 flex flex-wrap items-center gap-2">
          <button
            onClick={onPreview}
            className="studio-btn rounded-xl border border-outline-variant px-4 py-2.5 text-sm font-bold transition hover:border-outline"
          >
            {previewing ? t('myStudio.stopPreview') : t('myStudio.preview')}
          </button>

          {locked ? (
            <span className="flex items-center gap-1.5 text-sm font-bold text-outline">
              <span className="material-symbols-outlined text-[18px]">lock</span>
              {item.levelLocked
                ? t('myStudio.needLevel', { level: item.requiredLevel })
                : t('myStudio.earned')}
            </span>
          ) : (
            <button
              disabled={busy || !enough}
              onClick={onUnlock}
              className="studio-btn flex items-center gap-1.5 rounded-xl bg-student-accent px-5 py-2.5 text-sm font-bold text-on-student-accent transition hover:bg-student-accent-hover disabled:opacity-60"
            >
              <span className="material-symbols-outlined text-[18px]">paid</span>
              {t('myStudio.unlockFor', { coins: item.costCoins })}
            </button>
          )}
        </div>

        {!enough && !locked && (
          <p className="mt-2 text-sm font-bold text-error">{t('myStudio.notEnough')}</p>
        )}
      </div>
    </article>
  );
}

/**
 * The teachers whose look a student can wear.
 *
 * Free and always theirs, so there is no price and no lock — and it is the way
 * back after trying a theme on, which is the whole reason it is drawn first.
 */
function AcademyThemes({
  rows,
  onEquip,
  busy,
  t,
}: {
  rows: {
    academyId: string;
    name: string;
    teacherName: string;
    primary: string | null;
    accent: string | null;
    equipped: boolean;
    isDefault: boolean;
  }[];
  onEquip: (id: string) => void;
  busy: boolean;
  t: any;
}) {
  return (
    <div className="mb-5">
      <p className="mb-1 font-heading font-bold">{t('myStudio.teacherThemes')}</p>
      <p className="mb-3 text-sm text-on-surface-variant">{t('myStudio.teacherThemesHint')}</p>
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {rows.map((row) => (
          <article
            key={row.academyId}
            className={`studio-card card flex flex-col p-4 ${
              row.equipped ? 'studio-active border-student-accent' : ''
            }`}
          >
            <ThemePreview accent={row.primary ?? '#4a32c9'} accentDark={row.accent} />
            <p className="mt-3 truncate font-heading font-bold">
              {t('myStudio.teacherTheme', { name: row.teacherName })}
            </p>
            <p className="mt-1 truncate text-sm text-on-surface-variant">{row.name}</p>

            {row.equipped ? (
              <p className="mt-2 flex items-center gap-1 text-sm font-bold text-student-accent-ink">
                <span className="material-symbols-outlined text-[18px]">check_circle</span>
                {t('myStudio.equipped')}
              </p>
            ) : (
              <button
                disabled={busy}
                onClick={() => onEquip(row.academyId)}
                className="studio-btn mt-3 self-start rounded-xl bg-student-accent px-4 py-2 text-sm font-bold text-on-student-accent transition hover:bg-student-accent-hover disabled:opacity-60"
              >
                {t('myStudio.equip')}
              </button>
            )}
          </article>
        ))}
      </div>
    </div>
  );
}

function CategoryBar({
  category,
  setCategory,
  t,
  counts,
  advanced,
  toggleAdvanced,
}: {
  category: Category;
  setCategory: (c: Category) => void;
  t: any;
  counts: Map<Category, StudioItem[]>;
  advanced: boolean;
  toggleAdvanced: () => void;
}) {
  const shown = (advanced ? [...PRIMARY, ...ADVANCED] : PRIMARY).filter(
    (c) => (counts.get(c)?.length ?? 0) > 0,
  );
  return (
    <div className="scroll-x mb-5 -mx-6 px-6 sm:mx-0 sm:px-0">
      <div className="inline-flex min-w-full items-center gap-2">
        {shown.map((c) => (
          <button
            key={c}
            onClick={() => setCategory(c)}
            className={`studio-btn whitespace-nowrap rounded-xl border px-4 py-2 text-sm font-bold transition ${
              category === c
                ? 'studio-active border-student-accent bg-student-accent text-on-student-accent'
                : 'border-outline-variant text-on-surface-variant hover:border-outline'
            }`}
          >
            {t(`myStudio.category.${c}`)}
          </button>
        ))}
        <button
          onClick={toggleAdvanced}
          className="studio-btn whitespace-nowrap rounded-xl px-3 py-2 text-sm font-bold text-outline transition hover:text-on-surface"
        >
          {t(advanced ? 'myStudio.lessOptions' : 'myStudio.moreOptions')}
        </button>
      </div>
    </div>
  );
}

/** A colour of your own, from a palette or a picker. */
function AccentPicker({
  current,
  onPick,
  pending,
  t,
}: {
  current: string | null;
  onPick: (hex: string) => void;
  pending: boolean;
  t: any;
}) {
  const input = useRef<HTMLInputElement>(null);
  return (
    <div className="studio-card card mb-5 p-5">
      <p className="font-heading font-bold">{t('myStudio.myColour')}</p>
      <p className="mt-0.5 text-sm text-on-surface-variant">{t('myStudio.myColourHint')}</p>
      <div className="mt-3 flex flex-wrap items-center gap-2">
        {SWATCHES.map((hex) => (
          <button
            key={hex}
            aria-label={hex}
            disabled={pending}
            onClick={() => onPick(hex)}
            className={`h-9 w-9 rounded-full border-2 transition ${
              current === hex ? 'border-on-surface' : 'border-transparent hover:border-outline'
            }`}
            style={{ background: hex }}
          />
        ))}
        <button
          disabled={pending}
          onClick={() => input.current?.click()}
          className="studio-btn flex items-center gap-1.5 rounded-xl border border-outline-variant px-3 py-2 text-sm font-bold"
        >
          <span className="material-symbols-outlined text-[18px]">palette</span>
          {t('myStudio.pickColour')}
        </button>
        <input
          ref={input}
          type="color"
          className="sr-only"
          defaultValue={current ?? '#4a32c9'}
          onChange={(e) => onPick(e.target.value)}
        />
      </div>
    </div>
  );
}

function ItemGrid({
  items,
  heading,
  hint,
  equippedKey,
  equippedMap,
  previewing,
  ar,
  t,
  onPreview,
  onEquip,
  onUnlock,
  busy,
  empty,
}: {
  items: StudioItem[];
  heading?: string;
  hint?: string;
  equippedKey: string | null;
  equippedMap?: Record<string, string | null>;
  previewing: string | null;
  ar: boolean;
  t: any;
  onPreview: (i: StudioItem) => void;
  onEquip: (key: string) => void;
  onUnlock: (i: StudioItem) => void;
  busy: boolean;
  empty?: string;
}) {
  const body = !items.length ? null : (
    <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
      {items.map((item) => (
        <ItemCard
          key={item.key}
          item={item}
          equipped={
            equippedKey ? equippedKey === item.key : equippedMap?.[SLOT[item.category]] === item.key
          }
          previewing={previewing === item.key}
          ar={ar}
          t={t}
          onPreview={onPreview}
          onEquip={onEquip}
          onUnlock={onUnlock}
          busy={busy}
        />
      ))}
    </div>
  );
  if (heading && body) {
    return (
      <div className="mb-5">
        <p className="mb-1 font-heading font-bold">{heading}</p>
        {hint && <p className="mb-3 text-sm text-on-surface-variant">{hint}</p>}
        {body}
      </div>
    );
  }
  if (body) return body;
  {
    return (
      <div className="studio-card card p-10 text-center">
        <span className="material-symbols-outlined text-4xl text-outline">palette</span>
        <p className="mt-2 font-heading font-bold">{empty ?? t('myStudio.emptyCategory')}</p>
        <p className="mt-1 text-sm text-on-surface-variant">{t('myStudio.emptyHint')}</p>
      </div>
    );
  }
}

function ItemCard({
  item,
  equipped,
  previewing,
  ar,
  t,
  onPreview,
  onEquip,
  onUnlock,
  busy,
}: {
  item: StudioItem;
  equipped: boolean;
  previewing: boolean;
  ar: boolean;
  t: any;
  onPreview: (i: StudioItem) => void;
  onEquip: (key: string) => void;
  onUnlock: (i: StudioItem) => void;
  busy: boolean;
}) {
  const locked = item.levelLocked || item.achievementLocked;
  return (
    <article
      className={`studio-card studio-pop card flex flex-col p-4 ${
        equipped ? 'studio-active border-student-accent' : ''
      }`}
    >
      <Swatch item={item} />

      <div className="mt-3 flex items-start gap-2">
        <p className="min-w-0 flex-1 font-heading font-bold">{ar ? item.name.ar : item.name.en}</p>
        <span className={`shrink-0 rounded-full px-2 py-0.5 text-[11px] font-bold ${RARITY_TONE[item.rarity]}`}>
          {t(`myStudio.rarity.${item.rarity}`)}
        </span>
      </div>
      <p className="mt-1 line-clamp-2 text-sm text-on-surface-variant">
        {ar ? item.description.ar : item.description.en}
      </p>

      {/* Not colour alone: the tick and the word carry it for anyone who cannot
          tell the border apart. */}
      {equipped && (
        <p className="mt-2 flex items-center gap-1 text-sm font-bold text-student-accent-ink">
          <span className="material-symbols-outlined text-[18px]">check_circle</span>
          {t('myStudio.equipped')}
        </p>
      )}

      <div className="mt-auto flex flex-wrap items-center gap-2 pt-3">
        <button
          onClick={() => onPreview(item)}
          className="studio-btn rounded-xl border border-outline-variant px-3 py-2 text-sm font-bold transition hover:border-outline"
        >
          {previewing ? t('myStudio.stopPreview') : t('myStudio.preview')}
        </button>

        {item.owned && !equipped && (
          <button
            disabled={busy}
            onClick={() => onEquip(item.key)}
            className="studio-btn rounded-xl bg-student-accent px-4 py-2 text-sm font-bold text-on-student-accent transition hover:bg-student-accent-hover disabled:opacity-60"
          >
            {t('myStudio.equip')}
          </button>
        )}

        {item.purchasable && !locked && (
          <button
            disabled={busy}
            onClick={() => onUnlock(item)}
            className="studio-btn ms-auto flex items-center gap-1.5 rounded-xl bg-student-accent px-4 py-2 text-sm font-bold text-on-student-accent transition hover:bg-student-accent-hover disabled:opacity-60"
          >
            <span className="material-symbols-outlined text-[18px]">paid</span>
            {item.costCoins}
          </button>
        )}

        {item.levelLocked && (
          <span className="ms-auto flex items-center gap-1 text-xs font-bold text-outline">
            <span className="material-symbols-outlined text-[16px]">lock</span>
            {t('myStudio.needLevel', { level: item.requiredLevel })}
          </span>
        )}
        {item.achievementLocked && (
          <span className="ms-auto flex items-center gap-1 text-xs font-bold text-outline">
            <span className="material-symbols-outlined text-[16px]">workspace_premium</span>
            {t('myStudio.earned')}
          </span>
        )}
      </div>
    </article>
  );
}

/** What the item looks like, drawn from its own config rather than an image. */
/**
 * What the app looks like under a theme, in miniature.
 *
 * A gradient band only says "this one is red". It cannot say that the page
 * becomes a night stadium, which is the part somebody is actually buying — and
 * its absence is why a skin with its own ground still read as the same product
 * in another colour. So the preview is the product: a ground, a bar, a card, a
 * button and an earned value, each painted the way that theme paints it.
 *
 * Themes that bring no ground of their own are drawn on the platform's, which
 * is exactly what they will look like: an accent, honestly advertised.
 */
function ThemePreview({
  accent,
  accentDark,
  gold,
  surfaces,
  pattern,
  tall,
  sheen,
}: {
  accent: string;
  accentDark?: string | null;
  gold?: string | null;
  surfaces?: { background?: string; surface?: string; ink?: string } | null;
  pattern?: string | null;
  tall?: boolean;
  sheen?: boolean;
}) {
  const ground = surfaces?.background ?? null;
  const panel = surfaces?.surface ?? null;
  const ink = surfaces?.ink ?? null;
  const value = gold ?? accentDark ?? accent;
  // Without a ground of its own the mini sits on the page's, so the accent is
  // shown doing the only job it actually does.
  const bg = ground
    ? `linear-gradient(160deg, ${ground} 0%, ${panel ?? ground} 100%)`
    : `linear-gradient(135deg, ${accent}, ${accentDark ?? accent})`;

  return (
    <span
      aria-hidden="true"
      className={`relative block w-full overflow-hidden rounded-xl ${
        tall ? 'h-36 sm:h-44' : 'h-24'
      } ${sheen ? 'studio-sheen' : ''}`}
      style={{ background: bg }}
    >
      {/* The theme's own pattern, at the weight it is worn. */}
      {pattern === 'stadium' && ground && (
        <span
          className="absolute inset-0"
          style={{
            backgroundImage: [
              `radial-gradient(120% 70% at 50% -20%, ${value}22 0%, transparent 60%)`,
              `linear-gradient(to right, ${ink ?? '#fff'}14 1px, transparent 1px)`,
              `linear-gradient(to bottom, ${ink ?? '#fff'}0d 1px, transparent 1px)`,
            ].join(','),
            backgroundSize: '100% 100%, 28px 100%, 100% 28px',
          }}
        />
      )}

      <span className="absolute inset-0 flex flex-col gap-1.5 p-2.5">
        {/* The bar: a mark and two rows, the shapes anyone recognises as an app. */}
        <span className="flex items-center gap-1.5">
          <span className="h-3 w-3 rounded-md" style={{ background: accent }} />
          <span className="h-1.5 w-8 rounded-full" style={{ background: ink ?? '#ffffff', opacity: 0.5 }} />
          <span
            className="ms-auto h-3 w-7 rounded-full"
            style={{ background: value, opacity: 0.9 }}
          />
        </span>

        {/* The card: where everything in this product is read. */}
        <span
          className="mt-auto flex flex-col gap-1.5 rounded-lg p-2"
          style={{
            background: panel ?? (ground ?? '#ffffff'),
            border: `1px solid ${ink ?? '#ffffff'}1f`,
          }}
        >
          <span className="h-1.5 w-2/3 rounded-full" style={{ background: ink ?? '#101010', opacity: 0.85 }} />
          <span className="h-1.5 w-1/3 rounded-full" style={{ background: ink ?? '#101010', opacity: 0.4 }} />
          <span className="mt-0.5 flex items-center gap-1.5">
            <span className="h-3.5 w-12 rounded-md" style={{ background: accent }} />
            <span className="h-3.5 w-8 rounded-md" style={{ background: value, opacity: 0.85 }} />
          </span>
        </span>
      </span>
    </span>
  );
}

function Swatch({ item }: { item: StudioItem }) {
  const cfg = item.config as {
    accent?: string;
    accentDark?: string;
    gold?: string;
    secondary?: string;
    pattern?: string;
    surfaces?: { background?: string; surface?: string; ink?: string };
    hex?: string;
    style?: string;
  };
  const colour = cfg.hex ?? cfg.accent ?? null;
  if (colour) {
    return (
      <ThemePreview
        accent={colour}
        accentDark={cfg.accentDark}
        gold={cfg.gold ?? cfg.secondary}
        surfaces={cfg.surfaces}
        pattern={cfg.pattern}
        sheen={item.rarity === 'LEGENDARY'}
      />
    );
  }
  if (cfg.style) return <StylePreview category={item.category} style={cfg.style} />;
  return (
    <span className="grid h-24 w-full place-items-center rounded-xl bg-surface-container-high text-sm font-bold text-on-surface-variant">
      —
    </span>
  );
}

/** The ring colours, kept in step with `.studio-frame` in `index.css`. */
const FRAME_COLOUR: Record<string, string> = {
  bronze: '#b06b2c',
  silver: '#9ca3af',
  gold: '#d4a017',
  diamond: '#67e8f9',
  fire: '#f97316',
  lightning: '#facc15',
  scholar: '#92400e',
  legendary: '#a855f7',
};

const BUTTON_RADIUS: Record<string, string> = {
  classic: '8px',
  rounded: '12px',
  pill: '999px',
  sharp: '2px',
  soft: '14px',
  elevated: '14px',
};

const CARD_RADIUS: Record<string, string> = {
  minimal: '12px',
  soft: '20px',
  elevated: '16px',
  paper: '8px',
  glass: '16px',
};

/**
 * What a shape actually looks like, rather than what it is called.
 *
 * This slot used to print the style's own value — "pill", "paper" — into the
 * card, so an entire rung of the shop advertised itself with an internal
 * English identifier on an Arabic page. A student buying a shape should see the
 * shape; the drawings below are the same lengths and radii the stylesheet
 * applies, in miniature.
 */
function StylePreview({ category, style }: { category: Category; style: string }) {
  const shell = 'grid h-24 w-full place-items-center rounded-xl bg-surface-container-high p-3';

  if (category === 'FRAME') {
    const colour = FRAME_COLOUR[style] ?? '#9ca3af';
    const halo = ['diamond', 'fire', 'legendary'].includes(style);
    return (
      <span className={shell}>
        <span
          className="grid h-12 w-12 place-items-center rounded-full bg-surface-container-lowest font-heading font-bold text-on-surface-variant"
          style={{ boxShadow: `0 0 0 2px ${colour}${halo ? `, 0 0 12px -2px ${colour}` : ''}` }}
        >
          ط
        </span>
      </span>
    );
  }

  if (category === 'EFFECT') {
    return (
      <span className={shell}>
        <span
          className="rounded-lg bg-surface-container-lowest px-4 py-2 text-xs font-bold text-on-surface-variant"
          style={{
            boxShadow:
              style === 'glow'
                ? '0 0 0 1px rgb(var(--c-primary) / 0.35), 0 0 18px -4px rgb(var(--c-primary) / 0.55)'
                : undefined,
          }}
        >
          ●
        </span>
      </span>
    );
  }

  if (category === 'NAV_STYLE') {
    const gap = style === 'compact' ? '4px' : '8px';
    const radius = style === 'floating' ? '999px' : '8px';
    return (
      <span className={`${shell} items-stretch`}>
        <span className="flex w-full flex-col justify-center" style={{ gap }}>
          {[0.9, 0.45, 0.45].map((o, i) => (
            <span
              key={i}
              className="h-3.5 w-full bg-surface-container-lowest"
              style={{ borderRadius: radius, opacity: o }}
            />
          ))}
        </span>
      </span>
    );
  }

  if (category === 'CARD_STYLE') {
    return (
      <span className={shell}>
        <span
          className="flex h-full w-full flex-col justify-center gap-1.5 p-2"
          style={{
            borderRadius: CARD_RADIUS[style] ?? '12px',
            background:
              style === 'glass'
                ? 'rgb(var(--c-surface-container-lowest) / 0.6)'
                : 'rgb(var(--c-surface-container-lowest))',
            backdropFilter: style === 'glass' ? 'blur(4px)' : undefined,
            boxShadow: style === 'elevated' ? '0 8px 18px -10px rgb(0 0 0 / 0.5)' : undefined,
            border: style === 'paper' ? '1px solid rgb(var(--c-line) / 0.25)' : undefined,
          }}
        >
          <span className="h-1.5 w-2/3 rounded-full bg-on-surface/70" />
          <span className="h-1.5 w-1/3 rounded-full bg-on-surface/30" />
        </span>
      </span>
    );
  }

  // BUTTON_STYLE
  const radius = BUTTON_RADIUS[style] ?? '10px';
  return (
    <span className={shell}>
      <span className="flex items-center gap-2">
        <span
          className="h-7 w-16 bg-primary"
          style={{
            borderRadius: radius,
            boxShadow: style === 'elevated' ? '0 6px 16px -6px rgb(0 0 0 / 0.55)' : undefined,
          }}
        />
        <span
          className="h-7 w-12 border border-outline-variant bg-surface-container-lowest"
          style={{ borderRadius: radius }}
        />
      </span>
    </span>
  );
}

/**
 * Confirming a spend.
 *
 * It says the price and the balance side by side, because somebody about to
 * spend a currency they earned should not have to remember how much they had.
 */
function UnlockDialog({
  item,
  coins,
  ar,
  t,
  pending,
  onCancel,
  onConfirm,
}: {
  item: StudioItem;
  coins: number;
  ar: boolean;
  t: any;
  pending: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const enough = coins >= item.costCoins;
  return (
    <div
      className="fixed inset-0 z-50 grid place-items-center bg-black/50 p-4"
      role="dialog"
      aria-modal="true"
      onClick={onCancel}
    >
      <div
        className="w-full max-w-sm rounded-2xl bg-surface-container-lowest p-6 shadow-modal"
        onClick={(e) => e.stopPropagation()}
      >
        <Swatch item={item} />
        <p className="mt-3 font-heading text-lg font-extrabold">{ar ? item.name.ar : item.name.en}</p>
        <p className="mt-1 text-sm text-on-surface-variant">{ar ? item.description.ar : item.description.en}</p>

        <div className="mt-4 space-y-1.5 rounded-xl bg-surface-container-low p-3 text-sm">
          <p className="flex justify-between">
            <span>{t('myStudio.price')}</span>
            <span className="font-bold tabular-nums">{item.costCoins}</span>
          </p>
          <p className="flex justify-between">
            <span>{t('myStudio.yourCoins')}</span>
            <span className="font-bold tabular-nums">{coins}</span>
          </p>
          <p className="flex justify-between border-t border-outline-variant pt-1.5">
            <span>{t('myStudio.after')}</span>
            <span className={`font-bold tabular-nums ${enough ? '' : 'text-error'}`}>
              {coins - item.costCoins}
            </span>
          </p>
        </div>

        {!enough && <p className="mt-3 text-sm font-bold text-error">{t('myStudio.notEnough')}</p>}

        <div className="mt-5 flex gap-2">
          <button
            className="studio-btn flex-1 rounded-xl border border-outline-variant px-4 py-2.5 font-bold"
            onClick={onCancel}
          >
            {t('common.cancel')}
          </button>
          <button
            className="studio-btn flex-1 rounded-xl bg-student-accent px-4 py-2.5 font-bold text-on-student-accent transition hover:bg-student-accent-hover disabled:opacity-60"
            disabled={!enough || pending}
            onClick={onConfirm}
          >
            {pending ? <Spinner /> : t('myStudio.unlock')}
          </button>
        </div>
      </div>
    </div>
  );
}

/**
 * The tokens for one item, as the server derived them.
 *
 * Sent with the catalogue so trying something on is exactly what wearing it
 * would look like — including the contrast corrections — while still being a
 * local swap that writes nothing.
 */
function previewTheme(data: any, item: StudioItem): unknown {
  return item.preview ?? data.theme;
}
