import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api } from '../../lib/api';
import { applyStudio, previewStudio, restoreStudio } from '../../lib/studio';
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

/** The order the categories are offered in — the ones that change the most first. */
const CATEGORIES = [
  'THEME', 'ACCENT', 'BUTTON_STYLE', 'CARD_STYLE', 'NAV_STYLE', 'AVATAR', 'FRAME', 'EFFECT',
] as const;
type Category = (typeof CATEGORIES)[number];

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
  LEGENDARY: 'bg-amber-500/20 text-amber-600 dark:text-amber-300',
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
}

export default function StudioPage() {
  const { t, i18n } = useTranslation();
  const ar = i18n.language !== 'en';
  const qc = useQueryClient();
  const [tab, setTab] = useState<Tab>('style');
  const [category, setCategory] = useState<Category>('THEME');
  const [previewing, setPreviewing] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<StudioItem | null>(null);

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
      after(d.theme);
    },
  });
  const unlock = useMutation({
    mutationFn: async (key: string) => (await api.post('/student/studio/unlock', { key })).data,
    onSuccess: (_d, key) => {
      setConfirming(null);
      // Owned now — wear it, which is what somebody who just bought it wants.
      equip.mutate(key);
    },
  });
  const accent = useMutation({
    mutationFn: async (hex: string) => (await api.post('/student/studio/accent', { hex })).data,
    onSuccess: (d) => after(d.theme),
  });
  const reset = useMutation({
    mutationFn: async () => (await api.delete('/student/studio/customization')).data,
    onSuccess: (d) => {
      setPreviewing(null);
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
      <div className="mb-6 -mx-6 mt-6 overflow-x-auto px-6 sm:mx-0 sm:px-0">
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
          <CategoryBar category={category} setCategory={setCategory} t={t} counts={byCategory} />
          {category === 'ACCENT' && (
            <AccentPicker
              current={data.equipped?.accentHex ?? null}
              onPick={(hex) => accent.mutate(hex)}
              pending={accent.isPending}
              t={t}
            />
          )}
          <ItemGrid
            items={byCategory.get(category) ?? []}
            equippedKey={equippedKey(category)}
            previewing={previewing}
            ar={ar}
            t={t}
            onPreview={preview}
            onEquip={(k) => equip.mutate(k)}
            onUnlock={(item) => setConfirming(item)}
            busy={equip.isPending || unlock.isPending}
          />
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
        <ProgressBar pct={b.levelPct ?? 0} />
        <p className="mt-1.5 text-sm text-on-surface-variant">
          {t('myStudio.toNext', { xp: Math.max(0, (b.xpForNext ?? 0) - (b.xpIntoLevel ?? 0)) })}
        </p>
      </div>

      <div className="mt-4 grid grid-cols-3 gap-3 border-t border-outline-variant pt-4">
        <Stat icon="star" value={b.xp} label={t('myStudio.xp')} />
        <Stat icon="paid" value={b.coins} label={t('myStudio.coins')} />
        <Stat icon="local_fire_department" value={data.student.streak} label={t('myStudio.streak')} />
      </div>
    </div>
  );
}

function Stat({ icon, value, label }: { icon: string; value: number; label: string }) {
  return (
    <span className="text-center">
      <span className="material-symbols-outlined block text-[22px] text-student-accent-ink">{icon}</span>
      <span className="block font-heading text-lg font-extrabold tabular-nums">{value}</span>
      <span className="block text-xs text-on-surface-variant">{label}</span>
    </span>
  );
}

function CategoryBar({
  category,
  setCategory,
  t,
  counts,
}: {
  category: Category;
  setCategory: (c: Category) => void;
  t: any;
  counts: Map<Category, StudioItem[]>;
}) {
  return (
    <div className="mb-5 -mx-6 overflow-x-auto px-6 sm:mx-0 sm:px-0">
      <div className="inline-flex min-w-full gap-2">
        {CATEGORIES.filter((c) => (counts.get(c)?.length ?? 0) > 0).map((c) => (
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
  if (!items.length) {
    return (
      <div className="studio-card card p-10 text-center">
        <span className="material-symbols-outlined text-4xl text-outline">palette</span>
        <p className="mt-2 font-heading font-bold">{empty ?? t('myStudio.emptyCategory')}</p>
        <p className="mt-1 text-sm text-on-surface-variant">{t('myStudio.emptyHint')}</p>
      </div>
    );
  }
  return (
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
    <article className={`studio-card card flex flex-col p-4 ${equipped ? 'studio-active border-student-accent' : ''}`}>
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
function Swatch({ item }: { item: StudioItem }) {
  const cfg = item.config as { accent?: string; accentDark?: string; hex?: string; style?: string };
  const colour = cfg.hex ?? cfg.accent ?? null;
  if (colour) {
    return (
      <span
        className="block h-16 w-full rounded-xl"
        style={{ background: `linear-gradient(135deg, ${colour}, ${cfg.accentDark ?? colour})` }}
      />
    );
  }
  return (
    <span className="grid h-16 w-full place-items-center rounded-xl bg-surface-container-high text-sm font-bold text-on-surface-variant">
      {cfg.style ?? '—'}
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
 * The tokens for one item, as if it were the only thing equipped.
 *
 * Built from what the server already sent: previewing must not be a request,
 * and the catalogue carries each item's own configuration for exactly this.
 */
function previewTheme(data: any, item: StudioItem): unknown {
  const base = data.theme as { light: any; dark: any; styles: any };
  const cfg = item.config as { accent?: string; accentDark?: string; hex?: string; style?: string };

  // A colour swaps the accent; a shape swaps one attribute. Nothing else moves,
  // so a preview shows the one change and not a different app.
  if (cfg.hex || cfg.accent) {
    const light = { ...base.light, tokens: { ...base.light.tokens } };
    const dark = { ...base.dark, tokens: { ...base.dark.tokens } };
    const l = cfg.hex ?? cfg.accent!;
    const d = cfg.hex ?? cfg.accentDark ?? cfg.accent!;
    // Only the base accent is swapped locally; the derived variants stay the
    // ones the server produced, so a preview can never be more legible than the
    // real thing would be.
    light.tokens['--s-accent'] = hexToTriple(l) ?? light.tokens['--s-accent'];
    dark.tokens['--s-accent'] = hexToTriple(d) ?? dark.tokens['--s-accent'];
    return { light, dark, styles: base.styles };
  }

  const slot =
    item.category === 'BUTTON_STYLE' ? 'button'
    : item.category === 'CARD_STYLE' ? 'card'
    : item.category === 'NAV_STYLE' ? 'nav'
    : item.category === 'FRAME' ? 'frame'
    : item.category === 'AVATAR' ? 'avatar'
    : item.category === 'EFFECT' ? 'effect'
    : null;
  if (!slot || !cfg.style) return base;
  return { ...base, styles: { ...base.styles, [slot]: cfg.style } };
}

function hexToTriple(hex: string): string | null {
  const m = /^#([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return null;
  const n = parseInt(m[1], 16);
  return `${(n >> 16) & 255} ${(n >> 8) & 255} ${n & 255}`;
}
