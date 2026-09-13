import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
  OnModuleInit,
} from '@nestjs/common';
import { CosmeticCategory, CosmeticItem, Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { NotificationsService } from '../notifications/notifications.service';
import { GamificationConfigService } from '../gamification/gamification.config.service';
import { paletteFromBrandTokens } from '../branding/app-theme';
import { CATALOG } from './studio.catalog';
import { deriveStudioThemes, safeHex, StudioThemes, ThemeConfig } from './studio-theme';

/**
 * Student Studio.
 *
 * A teacher customises their Academy; a student customises their Darsly. This
 * owns the second half of that sentence: a catalogue of cosmetics, who owns
 * what, what they are wearing, and the arithmetic of paying for it.
 *
 * Three rules run through all of it.
 *
 *   - The student is the authenticated user, always. Nothing takes a student id
 *     from a request body, so there is no shape of request that reaches another
 *     student's collection or another student's coins.
 *   - Prices come from the catalogue row, never from the caller. The request
 *     names an item; the server decides what it costs.
 *   - Coins move the way every other coin in Darsly moves: a conditional
 *     decrement inside a transaction, with a uniquely-keyed row in the
 *     gamification ledger beside it. Two simultaneous unlocks cannot both
 *     succeed on one balance, and a replayed request cannot pay twice.
 *
 * It deliberately introduces no second economy. XP, coins, levels, achievements
 * and streaks are the ones already here.
 */

/** One slot per category: what a student wears is a set, not a pile. */
const SLOT: Record<CosmeticCategory, keyof EquipSlots> = {
  THEME: 'themeKey',
  ACCENT: 'accentKey',
  BUTTON_STYLE: 'buttonKey',
  CARD_STYLE: 'cardKey',
  NAV_STYLE: 'navKey',
  AVATAR: 'avatarKey',
  FRAME: 'frameKey',
  EFFECT: 'effectKey',
};

interface EquipSlots {
  /** The academy whose colours are being worn, when that is the choice. */
  academyId: string | null;
  themeKey: string | null;
  accentKey: string | null;
  buttonKey: string | null;
  cardKey: string | null;
  navKey: string | null;
  avatarKey: string | null;
  frameKey: string | null;
  effectKey: string | null;
}

/** A colour the student mixed themselves still has to be a colour. */
const CUSTOM_ACCENT = 'custom';

@Injectable()
export class StudioService implements OnModuleInit {
  constructor(
    private readonly prisma: PrismaService,
    private readonly notifications: NotificationsService,
    private readonly config: GamificationConfigService,
  ) {}

  /**
   * Keep the catalogue in step with the shipped one.
   *
   * Upserted rather than inserted-if-empty: a price or a translation changed in
   * code should reach an environment that already has the rows. An item an
   * admin has since retired stays retired — `isActive` is not overwritten once
   * the row exists.
   */
  async onModuleInit() {
    for (const item of CATALOG) {
      const shared = {
        category: item.category,
        rarity: item.rarity,
        nameAr: item.nameAr,
        nameEn: item.nameEn,
        descAr: item.descAr,
        descEn: item.descEn,
        config: item.config,
        costCoins: item.costCoins,
        requiredLevel: item.requiredLevel ?? 1,
        requiredAchievement: item.requiredAchievement ?? null,
        isStarter: item.isStarter ?? false,
        sortOrder: item.sortOrder,
      };
      await this.prisma.cosmeticItem
        .upsert({
          where: { key: item.key },
          update: shared,
          create: { key: item.key, isActive: true, ...shared },
        })
        .catch(() => undefined);
    }
  }

  // ── Identity ──────────────────────────────────────────────────────────────

  /**
   * The student behind the token.
   *
   * Every method starts here. It is the reason no endpoint in this service
   * accepts a student id: there is nothing to forge.
   */
  private async studentIdOf(userId: string): Promise<string> {
    const student = await this.prisma.studentProfile.findUnique({
      where: { userId },
      select: { id: true },
    });
    if (!student) throw new ForbiddenException('No student profile on this account');
    return student.id;
  }

  // ── Reading ───────────────────────────────────────────────────────────────

  /** Everything the Studio screen needs, in one request. */
  async overview(userId: string) {
    const studentId = await this.studentIdOf(userId);
    const [items, owned, worn, wallet, profile, achievements] = await Promise.all([
      this.prisma.cosmeticItem.findMany({
        where: { isActive: true },
        orderBy: [{ category: 'asc' }, { sortOrder: 'asc' }],
      }),
      this.prisma.studentCosmetic.findMany({ where: { studentId }, select: { itemId: true, source: true } }),
      this.customizationOf(studentId),
      this.prisma.studentGamification.findUnique({ where: { studentId } }),
      this.prisma.studentProfile.findUnique({
        where: { id: studentId },
        select: { currentStreak: true, user: { select: { fullName: true, avatarUrl: true } } },
      }),
      this.prisma.studentAchievement.findMany({
        where: { studentId },
        select: { achievement: { select: { key: true } } },
      }),
    ]);

    const xp = wallet?.xp ?? 0;
    const progress = await this.config.levelProgress(xp);
    const ownedIds = new Set(owned.map((o) => o.itemId));
    const earned = new Set(achievements.map((a) => a.achievement.key));

    return {
      student: {
        name: profile?.user.fullName ?? '',
        avatarUrl: profile?.user.avatarUrl ?? null,
        streak: profile?.currentStreak ?? 0,
      },
      balance: {
        coins: wallet?.coins ?? 0,
        xp,
        level: progress.level.level,
        levelName: { ar: progress.level.nameAr, en: progress.level.nameEn },
        xpIntoLevel: progress.xpIntoLevel,
        xpForNext: progress.xpForNext,
        levelPct: progress.pct,
      },
      equipped: worn,
      academyThemes: await this.academyThemes(studentId, worn.academyId, worn.themeKey),
      items: items.map((item) => this.toItemDto(item, ownedIds, earned, progress.level.level)),
      theme: this.themeFor(items, worn),
    };
  }

  /**
   * The teachers whose look a student can wear.
   *
   * Not catalogue rows: these are the academies they actually study at, read
   * fresh every time, so a student is only ever offered a palette they have a
   * real relationship with. Free, always owned, and the way back after trying
   * something on — "my teacher's look" as one tap rather than a reset.
   */
  private async academyThemes(
    studentId: string,
    chosen: string | null,
    wornThemeKey: string | null,
  ) {
    const rows = await this.prisma.enrollment.findMany({
      where: { studentId, status: { in: ['ACTIVE', 'PENDING_PAYMENT'] } },
      select: { tenantId: true, createdAt: true },
      orderBy: { createdAt: 'asc' },
    });
    const ids = [...new Set(rows.map((r) => r.tenantId))];
    if (!ids.length) return [];

    const academies = await this.prisma.academy.findMany({
      where: { id: { in: ids }, deletedAt: null, status: { not: 'ARCHIVED' } },
      select: {
        id: true, name: true, colorPrimary: true, colorAccent: true, brandTokens: true,
        owner: { select: { fullName: true } },
      },
    });
    const byId = new Map(academies.map((a) => [a.id, a]));

    // The first enrolment stays first: it is the teacher who brought them here,
    // and the one the app already wears when nothing has been chosen.
    return ids
      .map((id) => byId.get(id))
      .filter((a): a is NonNullable<typeof a> => !!a)
      .map((a, i) => {
        const palette = paletteFromBrandTokens(a.brandTokens, a.colorPrimary, a.colorAccent);
        return {
          academyId: a.id,
          name: a.name,
          teacherName: a.owner?.fullName ?? a.name,
          // For the swatch. The real tokens are the academy's own, applied by
          // the branding layer — this is only what the card should look like.
          primary: palette?.primary ?? null,
          accent: palette?.accent ?? null,
          // The first teacher is what the app wears only while nothing else is
          // on. With a bought theme worn, marking a teacher "in use" was both
          // untrue and a dead end: the card showed a tick instead of a button,
          // so the one tap back to a teacher's look was not on the page.
          equipped: chosen ? chosen === a.id : !wornThemeKey && i === 0,
          // True for the one the app already wears with no choice made.
          isDefault: i === 0,
        };
      });
  }

  /** Wear a teacher's colours, and stop wearing a bought theme. */
  async equipAcademy(userId: string, academyId: string) {
    const studentId = await this.studentIdOf(userId);
    // The gate: a student may only wear the colours of an academy they actually
    // study at. An id from a request is not a relationship.
    const enrolled = await this.prisma.enrollment.findFirst({
      where: { studentId, tenantId: academyId, status: { in: ['ACTIVE', 'PENDING_PAYMENT'] } },
      select: { id: true },
    });
    if (!enrolled) throw new ForbiddenException({ message: 'Not your academy', code: 'NOT_ENROLLED' });

    await this.prisma.studentCustomization.upsert({
      where: { studentId },
      update: { academyId, themeKey: null },
      create: { studentId, academyId },
    });
    return this.theme(userId);
  }

  /** The equipped set, with the row created lazily on first read. */
  private async customizationOf(studentId: string): Promise<EquipSlots & { accentHex: string | null }> {
    const row = await this.prisma.studentCustomization.findUnique({ where: { studentId } });
    return {
      academyId: row?.academyId ?? null,
      themeKey: row?.themeKey ?? null,
      accentKey: row?.accentKey ?? null,
      accentHex: row?.accentHex ?? null,
      buttonKey: row?.buttonKey ?? null,
      cardKey: row?.cardKey ?? null,
      navKey: row?.navKey ?? null,
      avatarKey: row?.avatarKey ?? null,
      frameKey: row?.frameKey ?? null,
      effectKey: row?.effectKey ?? null,
    };
  }

  /**
   * What a student may do with an item, decided here rather than in the browser.
   *
   * The client draws what this says. It does not compute it, which is what
   * stops a hidden "unlock" button being the only thing between somebody and a
   * legendary theme.
   */
  private toItemDto(
    item: CosmeticItem,
    ownedIds: Set<string>,
    earned: Set<string>,
    level: number,
  ) {
    const owned = ownedIds.has(item.id) || item.isStarter;
    const gate = item.requiredAchievement;
    return {
      id: item.id,
      key: item.key,
      category: item.category,
      rarity: item.rarity,
      name: { ar: item.nameAr, en: item.nameEn },
      description: { ar: item.descAr, en: item.descEn },
      config: item.config,
      costCoins: item.costCoins,
      requiredLevel: item.requiredLevel,
      requiredAchievement: gate,
      owned,
      // An achievement item is earned, never bought: showing a price on it would
      // be an offer the server would refuse.
      purchasable: !owned && !gate,
      levelLocked: !owned && item.requiredLevel > level,
      achievementLocked: !owned && !!gate && !earned.has(gate),
      // What the app would look like wearing this, derived here so trying
      // something on is exact rather than an approximation — and so previewing
      // stays a local swap that writes nothing.
      preview: this.previewFor(item),
    };
  }

  /** One item, resolved as if it were the only thing equipped. */
  private previewFor(item: CosmeticItem): StudioThemes {
    const cfg = (item.config ?? {}) as Record<string, unknown>;
    const style = typeof cfg.style === 'string' ? cfg.style : null;
    return deriveStudioThemes({
      themeConfig: item.category === 'THEME' ? (cfg as ThemeConfig) : null,
      accentHex: item.category === 'ACCENT' ? safeHex(cfg.hex) : null,
      button: item.category === 'BUTTON_STYLE' ? style : null,
      card: item.category === 'CARD_STYLE' ? style : null,
      nav: item.category === 'NAV_STYLE' ? style : null,
      frame: item.category === 'FRAME' ? style : null,
      avatar: item.category === 'AVATAR' ? style : null,
      effect: item.category === 'EFFECT' ? style : null,
    });
  }

  /** Resolve the worn set into tokens, on the server, where the floors are. */
  private themeFor(items: CosmeticItem[], worn: EquipSlots & { accentHex: string | null }): StudioThemes {
    const byKey = new Map(items.map((i) => [i.key, i]));
    const cfg = (key: string | null): Record<string, unknown> =>
      (key ? ((byKey.get(key)?.config ?? {}) as Record<string, unknown>) : {});

    const themeConfig = cfg(worn.themeKey) as ThemeConfig;
    // An unlocked accent is a hex in its own config; a mixed one is on the row.
    const accentFromItem = worn.accentKey === CUSTOM_ACCENT ? null : safeHex(cfg(worn.accentKey).hex);

    return deriveStudioThemes({
      themeConfig,
      accentHex: worn.accentHex ?? accentFromItem,
      button: cfg(worn.buttonKey).style as string,
      card: cfg(worn.cardKey).style as string,
      nav: cfg(worn.navKey).style as string,
      frame: cfg(worn.frameKey).style as string,
      avatar: cfg(worn.avatarKey).style as string,
      effect: cfg(worn.effectKey).style as string,
    });
  }

  /** The tokens alone — what the app asks for on load, without the catalogue. */
  async theme(userId: string) {
    const studentId = await this.studentIdOf(userId);
    const worn = await this.customizationOf(studentId);
    const keys = [
      worn.themeKey, worn.accentKey, worn.buttonKey, worn.cardKey,
      worn.navKey, worn.avatarKey, worn.frameKey, worn.effectKey,
    ].filter((k): k is string => !!k);
    const items = keys.length
      ? await this.prisma.cosmeticItem.findMany({ where: { key: { in: keys } } })
      : [];
    return { equipped: worn, theme: this.themeFor(items, worn) };
  }

  // ── Unlocking ─────────────────────────────────────────────────────────────

  /**
   * Buy one cosmetic.
   *
   * The whole of it is one transaction, and the debit is a conditional update
   * rather than a read followed by a write: two requests racing on a balance of
   * 500 cannot both spend it, because the second one matches no row. The unique
   * ownership constraint is the second half of the same idea — a double click
   * that gets past the balance check still cannot create a second row, and the
   * transaction that tried is rolled back whole.
   */
  async unlock(userId: string, key: string) {
    const studentId = await this.studentIdOf(userId);
    const item = await this.prisma.cosmeticItem.findUnique({ where: { key } });
    if (!item || !item.isActive) throw new NotFoundException('This item is not available');
    if (item.isStarter) throw new BadRequestException({ message: 'Already yours', code: 'ALREADY_OWNED' });

    const already = await this.prisma.studentCosmetic.findUnique({
      where: { studentId_itemId: { studentId, itemId: item.id } },
    });
    if (already) throw new BadRequestException({ message: 'Already owned', code: 'ALREADY_OWNED' });

    if (item.requiredAchievement) {
      throw new BadRequestException({
        message: 'This one is earned, not bought',
        code: 'ACHIEVEMENT_ONLY',
      });
    }

    const wallet = await this.prisma.studentGamification.findUnique({ where: { studentId } });
    const progress = await this.config.levelProgress(wallet?.xp ?? 0);
    if (progress.level.level < item.requiredLevel) {
      throw new BadRequestException({ message: 'Level too low', code: 'LEVEL_TOO_LOW' });
    }

    try {
      await this.prisma.$transaction(async (tx) => {
        // The debit and its guard are the same statement: no window between
        // checking a balance and spending it.
        const paid = await tx.studentGamification.updateMany({
          where: { studentId, coins: { gte: item.costCoins } },
          data: {
            coins: { decrement: item.costCoins },
            coinsSpent: { increment: item.costCoins },
          },
        });
        if (!paid.count) {
          throw new BadRequestException({ message: 'Not enough coins', code: 'NOT_ENOUGH_COINS' });
        }
        // Ownership is what makes an unlock exactly-once: the row is unique on
        // (student, item), so a replay or a second racing request dies here,
        // inside the transaction, before anything is charged.
        const owned = await tx.studentCosmetic.create({
          data: { studentId, itemId: item.id, source: 'PURCHASE', costCoins: item.costCoins },
        });
        await tx.gamificationEvent.create({
          data: {
            studentId,
            type: 'COSMETIC_UNLOCKED',
            entityType: 'cosmetic',
            entityId: item.key,
            xpAwarded: 0,
            coinsAwarded: -item.costCoins,
            // Keyed on the purchase, not on the pair. Keyed on the pair it was
            // permanent: a refund deletes the ownership row but must not erase
            // the ledger, so the dead key stayed behind and every later attempt
            // to buy the same item again collided with it — the student was
            // told "already owned" while owning nothing, with no way back.
            idempotencyKey: `COSMETIC:${owned.id}`,
            meta: { key: item.key, category: item.category } as Prisma.InputJsonValue,
          },
        });
      });
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        throw new BadRequestException({ message: 'Already owned', code: 'ALREADY_OWNED' });
      }
      throw err;
    }

    await this.notifications
      .create({
        userId,
        type: 'ANNOUNCEMENT',
        title: '🎨 فتحت عنصر جديد',
        body: `${item.nameAr} بقى في مجموعتك.`,
        meta: { cosmeticKey: item.key },
      })
      .catch(() => undefined);

    const after = await this.prisma.studentGamification.findUnique({ where: { studentId } });
    return { unlocked: true, key: item.key, coins: after?.coins ?? 0 };
  }

  /**
   * Hand over the items an achievement earns.
   *
   * Called when the Studio is read rather than from inside the achievement
   * engine, so nothing about how badges are awarded changes. Idempotent: the
   * ownership constraint makes a second grant a no-op.
   */
  async syncEarned(userId: string) {
    const studentId = await this.studentIdOf(userId);
    const [earned, items] = await Promise.all([
      this.prisma.studentAchievement.findMany({
        where: { studentId },
        select: { achievement: { select: { key: true } } },
      }),
      this.prisma.cosmeticItem.findMany({
        where: { isActive: true, requiredAchievement: { not: null } },
      }),
    ]);
    const keys = new Set(earned.map((a) => a.achievement.key));
    const due = items.filter((i) => i.requiredAchievement && keys.has(i.requiredAchievement));
    if (!due.length) return { granted: 0 };

    const granted = await this.prisma.studentCosmetic.createMany({
      data: due.map((i) => ({ studentId, itemId: i.id, source: 'ACHIEVEMENT', costCoins: 0 })),
      skipDuplicates: true,
    });
    return { granted: granted.count };
  }

  // ── Wearing ───────────────────────────────────────────────────────────────

  /**
   * Put something on.
   *
   * Ownership is checked here and not taken on trust from the screen that drew
   * the button: the only way an item reaches a slot is if the student owns it
   * or it is one of the starters everybody has.
   */
  async equip(userId: string, key: string) {
    const studentId = await this.studentIdOf(userId);
    const item = await this.prisma.cosmeticItem.findUnique({ where: { key } });
    if (!item || !item.isActive) throw new NotFoundException('This item is not available');

    if (!item.isStarter) {
      const owned = await this.prisma.studentCosmetic.findUnique({
        where: { studentId_itemId: { studentId, itemId: item.id } },
      });
      if (!owned) throw new ForbiddenException({ message: 'Not owned', code: 'NOT_OWNED' });
    }

    const slot = SLOT[item.category];
    const data: Record<string, unknown> = { [slot]: item.key };
    // Two looks cannot be worn at once: choosing a theme releases the academy.
    if (item.category === 'THEME') data.academyId = null;
    // Equipping an unlocked accent replaces a mixed one, rather than layering
    // two answers to the same question.
    if (item.category === 'ACCENT') data.accentHex = null;

    await this.prisma.studentCustomization.upsert({
      where: { studentId },
      update: data,
      create: { studentId, ...data },
    });
    return this.theme(userId);
  }

  /** Take the slot back to the platform default. */
  async unequip(userId: string, category: CosmeticCategory) {
    const studentId = await this.studentIdOf(userId);
    const slot = SLOT[category];
    if (!slot) throw new BadRequestException('Unknown category');
    const data: Record<string, unknown> = { [slot]: null };
    if (category === 'ACCENT') data.accentHex = null;
    await this.prisma.studentCustomization.upsert({
      where: { studentId },
      update: data,
      create: { studentId, ...data },
    });
    return this.theme(userId);
  }

  /**
   * A colour the student mixed rather than unlocked.
   *
   * Stored as the hex they chose and nothing else. Every variant around it —
   * hover, the soft fill, the text that goes on top — is derived on read, so a
   * colour that would be unreadable is corrected rather than saved.
   */
  async setAccent(userId: string, hex: string) {
    const studentId = await this.studentIdOf(userId);
    const value = safeHex(hex);
    if (!value) throw new BadRequestException({ message: 'Not a colour', code: 'BAD_COLOR' });
    await this.prisma.studentCustomization.upsert({
      where: { studentId },
      update: { accentHex: value, accentKey: CUSTOM_ACCENT },
      create: { studentId, accentHex: value, accentKey: CUSTOM_ACCENT },
    });
    return this.theme(userId);
  }

  /**
   * Back to how Darsly looks out of the box.
   *
   * Clears what is worn and nothing else: the collection, the coins, the XP,
   * the badges and the streak are untouched. Resetting how something looks is
   * not a reason to lose what it took to get there.
   */
  async reset(userId: string) {
    const studentId = await this.studentIdOf(userId);
    await this.prisma.studentCustomization.upsert({
      where: { studentId },
      update: {
        academyId: null,
        themeKey: null, accentKey: null, accentHex: null, buttonKey: null,
        cardKey: null, navKey: null, avatarKey: null, frameKey: null, effectKey: null,
      },
      create: { studentId },
    });
    return this.theme(userId);
  }
}
