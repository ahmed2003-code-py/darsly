import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api } from '../../lib/api';
import { useLocalized } from '../../lib/gamification';
import { EngagementPanel } from '../../components/gamification/EngagementPanel';
import { ErrorNote, PageHeader, Skeleton } from '../../components/ui';

const TABS = ['analytics', 'rules', 'levels', 'achievements', 'rewards', 'redemptions'] as const;
type Tab = (typeof TABS)[number];

/**
 * The control centre.
 *
 * The economy is stored as data precisely so it can be changed here — what a
 * lesson is worth, where a level sits, whether an achievement is still offered.
 * Every edit is a single PATCH and takes effect on the next award; there is no
 * publish step and no deploy.
 */
export default function AdminGamificationPage() {
  const { t } = useTranslation();
  const [tab, setTab] = useState<Tab>('analytics');

  return (
    <div className="mx-auto max-w-container px-6 py-8 sm:px-8">
      <PageHeader title={t('engagement.adminTitle')} subtitle={t('engagement.adminSubtitle')} />

      <div className="mb-6 -mx-6 overflow-x-auto px-6 sm:mx-0 sm:px-0">
        <div className="inline-flex min-w-full gap-1 rounded-full bg-surface-container-high p-1">
          {TABS.map((k) => (
            <button
              key={k}
              type="button"
              onClick={() => setTab(k)}
              className={`whitespace-nowrap rounded-full px-4 py-2 text-sm font-bold transition ${
                tab === k ? 'bg-surface-container-lowest text-primary shadow-hairline' : 'text-on-surface-variant'
              }`}
            >
              {t(`engagement.tabs.${k}`)}
            </button>
          ))}
        </div>
      </div>

      {tab === 'analytics' && <EngagementPanel scope="admin" />}
      {tab !== 'analytics' && tab !== 'redemptions' && <ConfigTab tab={tab} />}
      {tab === 'redemptions' && <RedemptionsTab />}
    </div>
  );
}

function useConfig() {
  return useQuery<{ rules: any[]; levels: any[]; achievements: any[]; rewards: any[] }>({
    queryKey: ['gamification-config'],
    queryFn: async () => (await api.get('/admin/gamification/config')).data,
  });
}

function ConfigTab({ tab }: { tab: Exclude<Tab, 'analytics' | 'redemptions'> }) {
  const { t } = useTranslation();
  const L = useLocalized();
  const qc = useQueryClient();
  const { data, isLoading } = useConfig();
  const [dirty, setDirty] = useState<Record<string, any>>({});

  const save = useMutation({
    mutationFn: async ({ path, body }: { path: string; body: any }) =>
      (await api.patch(`/admin/gamification/${path}`, body)).data,
    onSuccess: () => qc.invalidateQueries({ queryKey: ['gamification-config'] }),
  });

  if (isLoading) return <Skeleton className="h-64 rounded-3xl" />;

  const field = (id: string, key: string, fallback: any) =>
    dirty[`${id}.${key}`] !== undefined ? dirty[`${id}.${key}`] : fallback;
  const set = (id: string, key: string, v: any) => setDirty((d) => ({ ...d, [`${id}.${key}`]: v }));
  const changesFor = (id: string) =>
    Object.fromEntries(
      Object.entries(dirty)
        .filter(([k]) => k.startsWith(`${id}.`))
        .map(([k, v]) => [k.split('.')[1], v]),
    );

  const rows =
    tab === 'rules' ? data!.rules : tab === 'levels' ? data!.levels : tab === 'achievements' ? data!.achievements : data!.rewards;

  return (
    <div className="space-y-3">
      <ErrorNote error={save.error} />
      {rows.map((r: any) => {
        const id = tab === 'rules' ? r.event : tab === 'levels' ? String(r.level) : r.key;
        const path =
          tab === 'rules' ? `xp-rules/${id}` : tab === 'levels' ? `levels/${id}` : `${tab}/${id}`;
        const changed = Object.keys(changesFor(id)).length > 0;

        return (
          <div key={id} className="card flex flex-wrap items-end gap-3">
            <div className="min-w-[10rem] flex-1">
              <p className="font-heading font-bold">
                {tab === 'rules'
                  ? t([`gamification.events.${r.event}`, r.event])
                  : tab === 'levels'
                    ? `${t('engagement.level')} ${r.level} — ${L({ ar: r.nameAr, en: r.nameEn })}`
                    : L({ ar: r.titleAr, en: r.titleEn })}
              </p>
              <p className="text-xs text-outline">{id}</p>
            </div>

            {tab === 'rules' && (
              <>
                <Num label={t('engagement.xpCol')} value={field(id, 'xp', r.xp)} onChange={(v) => set(id, 'xp', v)} />
                <Num label={t('engagement.coinsCol')} value={field(id, 'coins', r.coins)} onChange={(v) => set(id, 'coins', v)} />
                <Num label={t('engagement.dailyCap')} hint={t('engagement.capHint')} value={field(id, 'dailyCap', r.dailyCap)} onChange={(v) => set(id, 'dailyCap', v)} />
                <Num label={t('engagement.perEntity')} hint={t('engagement.capHint')} value={field(id, 'perEntityLimit', r.perEntityLimit)} onChange={(v) => set(id, 'perEntityLimit', v)} />
                <Toggle label={t('engagement.active')} value={field(id, 'isActive', r.isActive)} onChange={(v) => set(id, 'isActive', v)} />
              </>
            )}
            {tab === 'levels' && (
              <>
                <Num label={t('engagement.minXp')} value={field(id, 'minXp', r.minXp)} onChange={(v) => set(id, 'minXp', v)} />
                <Num label={t('engagement.coinsCol')} value={field(id, 'coinReward', r.coinReward)} onChange={(v) => set(id, 'coinReward', v)} />
              </>
            )}
            {tab === 'achievements' && (
              <>
                <Num label={t('engagement.threshold')} value={field(id, 'threshold', r.threshold)} onChange={(v) => set(id, 'threshold', v)} />
                <Num label={t('engagement.xpCol')} value={field(id, 'xpReward', r.xpReward)} onChange={(v) => set(id, 'xpReward', v)} />
                <Num label={t('engagement.coinsCol')} value={field(id, 'coinReward', r.coinReward)} onChange={(v) => set(id, 'coinReward', v)} />
                <Toggle label={t('engagement.active')} value={field(id, 'isActive', r.isActive)} onChange={(v) => set(id, 'isActive', v)} />
              </>
            )}
            {tab === 'rewards' && (
              <>
                <Num label={t('engagement.cost')} value={field(id, 'costCoins', r.costCoins)} onChange={(v) => set(id, 'costCoins', v)} />
                <Toggle label={t('engagement.active')} value={field(id, 'isActive', r.isActive)} onChange={(v) => set(id, 'isActive', v)} />
              </>
            )}

            <button
              type="button"
              className="btn-primary px-4 py-1.5 text-sm disabled:opacity-40"
              disabled={!changed || save.isPending}
              onClick={() => {
                save.mutate({ path, body: changesFor(id) });
                setDirty((d) => Object.fromEntries(Object.entries(d).filter(([k]) => !k.startsWith(`${id}.`))));
              }}
            >
              {t('engagement.save')}
            </button>
          </div>
        );
      })}
    </div>
  );
}

function Num({ label, value, onChange, hint }: { label: string; value: number; onChange: (v: number) => void; hint?: string }) {
  return (
    <label className="w-24">
      <span className="mb-1 block text-xs font-semibold text-on-surface-variant">{label}</span>
      <input
        type="number"
        min={0}
        className="input py-1.5 text-sm"
        value={value}
        onChange={(e) => onChange(Math.max(0, Number(e.target.value)))}
      />
      {hint && <span className="mt-0.5 block text-[10px] text-outline">{hint}</span>}
    </label>
  );
}

function Toggle({ label, value, onChange }: { label: string; value: boolean; onChange: (v: boolean) => void }) {
  return (
    <label className="flex cursor-pointer items-center gap-2 pb-2">
      <input type="checkbox" checked={!!value} onChange={(e) => onChange(e.target.checked)} className="h-4 w-4 accent-primary" />
      <span className="text-sm font-semibold text-on-surface-variant">{label}</span>
    </label>
  );
}

function RedemptionsTab() {
  const { t } = useTranslation();
  const L = useLocalized();
  const qc = useQueryClient();
  const { data, isLoading } = useQuery<any[]>({
    queryKey: ['gamification-redemptions'],
    queryFn: async () => (await api.get('/admin/gamification/redemptions')).data,
  });
  const fulfil = useMutation({
    mutationFn: async (id: string) => (await api.post(`/admin/gamification/redemptions/${id}/fulfil`)).data,
    onSuccess: () => qc.invalidateQueries({ queryKey: ['gamification-redemptions'] }),
  });

  if (isLoading) return <Skeleton className="h-40 rounded-3xl" />;
  if (!data?.length) {
    return <p className="card py-10 text-center text-sm text-on-surface-variant">{t('engagement.noPending')}</p>;
  }

  return (
    <div className="space-y-3">
      {data.map((r) => (
        <div key={r.id} className="card flex flex-wrap items-center gap-3">
          <div className="min-w-[12rem] flex-1">
            <p className="font-heading font-bold">{L({ ar: r.reward.titleAr, en: r.reward.titleEn })}</p>
            <p className="text-sm text-on-surface-variant">{r.student.user.fullName}</p>
          </div>
          <span className="font-heading font-extrabold text-amber-600">{r.costCoins}</span>
          <button className="btn-primary px-4 py-1.5 text-sm" onClick={() => fulfil.mutate(r.id)} disabled={fulfil.isPending}>
            {t('engagement.fulfil')}
          </button>
        </div>
      ))}
    </div>
  );
}
