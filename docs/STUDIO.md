# Darsly — Personalisation & Theming

How the app decides what colour it is, who gets to decide that, and what stops
a chosen colour from making the product unreadable.

Two different people customise Darsly, and they are not the same feature:

| | Academy Studio | Student Studio |
|---|---|---|
| Who | a teacher | a student |
| What it changes | the academy's brand, everywhere that academy appears | the student's own copy of the app |
| Where it lives | `apps/api/src/academy-site`, `/academy/studio` | `apps/api/src/studio`, `/studio` |
| Who sees it | the teacher, their staff, and their students | only that student |
| Token prefix | `--c-*` | `--s-*`, plus an allowlisted subset of `--c-*` |

This document is about the second one and about the layer both share. For the
AI site generator behind the first, see
[ACADEMY-COMPOSITION-PLAN.md](./ACADEMY-COMPOSITION-PLAN.md).

---

## 1. The two layers

Every colour in the product resolves through a CSS custom property rather than
a literal. That single decision is what makes runtime theming possible at all:
the API derives a token set, the browser sets the variables on `<html>`, and
every existing Tailwind utility follows without a per-screen edit.

```
--c-*   the platform's own palette, overwritten by an academy when it publishes
--s-*   the student's personalisation, layered on top
```

Tailwind resolves a student token with the academy token as its fallback:

```ts
// apps/web/tailwind.config.ts
const c  = (name)            => `rgb(var(--c-${name}) / <alpha-value>)`;
const c2 = (name, fallback)  => `rgb(var(--${name}, var(--${fallback})) / <alpha-value>)`;

'student-accent': c2('s-accent', 'c-primary'),
'student-gold':   c2('s-gold',   'c-gold'),
```

A student who has customised nothing sets no `--s-*` at all, so every token
falls through to the academy's, and the app looks exactly as it did. **That
fallback is the whole design.** There is no "default student theme" to keep in
sync with the platform.

### Why a student may also write `--c-*`

A theme that only moved `--s-*` stopped at the handful of components that had
been taught to read it. To reach the logo, the nav, every primary button and
every active row, the student layer also restates a **fixed allowlist** of
`--c-*` names — the accent family and, for a skin that brings its own ground,
the surface family.

The allowlist is declared on both sides and a test compares them, because a
token the server derives and the client has not been told about is dropped
silently:

- server — `BRAND_OVERRIDE_NAMES` in `studio-theme.ts` (derived from the
  functions themselves, so it cannot drift)
- client — `BRAND_ALLOWED` in `apps/web/src/lib/studio.ts`
- the test — *"names every brand token the client is willing to accept"*

Names that are **not** reachable, by construction: `--c-error`, `--c-success`,
`--c-secondary`, `--c-tertiary`. An error must stay red-for-error, not
red-for-whatever-theme-you-bought.

### The `written[]` invariant

> **The student layer may only remove variables it itself wrote.**

This is guarded by a test and it is not a style preference. `paint()` keeps an
array of the `--c-*` names it set and clears exactly those on the next paint.

The alternative — clearing the whole allowlist each time — shipped once and
caused a production-wide regression (`1b63835`): with an empty catalogue it
removed the academy's primary family and wrote nothing back, so every teacher
and every student fell back to platform indigo. The fix is four lines; the
reason it happened is worth remembering.

### Repaint without coupling

`theme.ts` (academy) and `studio.ts` (student) do not import each other. They
talk through events:

| Event | Fired by | Listened to by | Means |
|---|---|---|---|
| `darsly:academy-theme` | `theme.ts` | `studio.ts` | the academy just repainted; re-apply on top |
| `darsly:studio-academy` | `studio.ts` | `BrandTheme.tsx` | the student picked a different teacher's look |

---

## 2. Colour is decided on the server, never in the browser

`apps/api/src/studio/studio-theme.ts` is the only place a student's colour is
calculated. The browser receives finished `"R G B"` triples and sets them. It
never mixes, never lightens, never decides.

That is a security boundary as much as a design one: a token value that the
client composed could carry `url(...)`, and a theme config is user-adjacent
data. Every emitted value matches `/^\d{1,3} \d{1,3} \d{1,3}$/`, asserted by a
test.

### The floors

```
AAA body text        7.0 : 1     --c-on-surface on the page
text                 4.5 : 1     muted text, outlines, any colour used as a label
text on a fill       4.5 : 1     --c-on-primary on --c-primary
non-text             3.0 : 1     a fill, a bar, a border
```

`legible(fg, bg, target)` walks a colour toward a pole until it clears the
floor. A colour that cannot be read on the ground it is drawn on is **moved**,
rather than shipped and apologised for.

### Seating: the ground and the seat

Two different surfaces matter, and conflating them is how bugs get shipped:

- **the ground** — the page a colour is mixed against (`--c-background`)
- **the seat** — the hardest surface it must remain legible on, which is the
  deepest panel (`surfaceSeat()` = the background mixed 18% toward the ink)

Fills are floored against whichever of the two actually binds (`hardest()`);
labels are floored against the seat, because most of the product's text sits on
a card rather than on the page. Seating against the page alone left brand text
at 4.43:1 on a card — a floor missed by a hair, on the surface text mostly
lives on.

### Fill and label are two tokens

`bg-primary` is a fill and `text-primary` is a label, and they are not held to
the same floor. Holding one colour to both is how a crimson button becomes
salmon: pushed to 4.5:1 against near-black navy, `#dc2626` walks all the way to
`#ea7d7d`.

So `deriveBrand` emits both, and Tailwind re-points only the text utility:

```ts
textColor: {
  primary: `rgb(var(--c-primary-text, var(--c-primary)) / <alpha-value>)`,
}
```

A theme that never sets `--c-primary-text` behaves exactly as it always did.

---

## 3. What a theme can say

`ThemeConfig` is a **closed vocabulary**. The server reads names it knows and
drops anything else. There is no CSS, no HTML, no JavaScript, and no free-form
value anywhere in a theme — by design, and stated as a constraint in the
original brief.

```ts
interface ThemeConfig {
  accent?, accentDark?        // the action colour, per ground
  secondary?, secondaryDark?  // the partner colour
  gold?, goldDark?            // what "earned" looks like, per ground
  wash?, washDark?            // a faint tint over the page
  surfaces?                   // a ground of its own  (dark end)
  surfacesLight?              // a ground of its own  (light end)
  pattern?                    // 'none' | 'web' | 'halftone' | 'pitch' | 'speed'
                              // | 'grid' | 'glow' | 'rays' | 'stadium'
  glow?                       // ambient light behind the page
  font?                       // 'default' | 'display' | 'tech' | 'round'
  radius?                     // 'default' | 'sharp' | 'soft' | 'round'
  button?                     // 'classic' | 'rounded' | 'pill' | 'sharp' | 'soft' | 'elevated'
  card?                       // 'minimal' | 'soft' | 'elevated' | 'paper' | 'glass'
  nav?                        // 'classic' | 'compact' | 'floating'
}
```

Shape choices become **attributes**, not variables — `data-s-card="elevated"` —
so the stylesheet decides what "elevated" means and a style name can never
become a length or a colour.

### A tint versus a skin

A theme that only moves the accent leaves the platform's greys underneath. That
is the *"it just looks red"* failure, and it is what `surfaces` exists to fix.

A theme that declares `surfaces` brings its own page: `deriveSurfaces()` emits
18 contrast-floored surface tokens from four inputs (`background`, `surface`,
`ink`, `line`). Panels step from the background toward the ink — one rule that
is right in light and in dark, rather than a branch that can be wrong in one.

`surfacesLight` is the same skin for a reader who prefers light. The identity —
accent, gold, pattern, typeface — carries across; only the ground changes. A
skin that omits it wears its one ground at both ends, which is the right answer
for a look that only makes sense in the dark.

**The seating follows the ground, not the switch.** A hover brightens on a dark
page and darkens on a light one, so the mode is read from the ground a skin
lays down (`groundMode()`), not from what the reader chose.

### Typefaces

Each font name maps to a family stack that **always ends in the Arabic face the
product ships with**. An English display font has no Arabic glyphs, and a theme
must never cost a student their own script. The webfont is fetched the first
time a theme wearing it is painted, so pairings nobody equips are never
downloaded.

---

## 4. The economy

Coins buy cosmetics. **XP is never spent** — it is progression, and it gates
availability through `requiredLevel`, so unlocking a theme can never cost a
student the level they earned. There is no second currency and no second XP
system; see [GAMIFICATION.md](./GAMIFICATION.md).

### The rules, and how each is enforced

| Rule | Enforcement |
|---|---|
| The price comes from the catalogue, never the request | the DTO has no price field; the service reads `item.costCoins` |
| A balance cannot be spent twice | `updateMany({ where: { coins: { gte: cost } } })` inside a transaction — the conditional update *is* both the insufficient-funds signal and the race guard |
| An item cannot be bought twice | `@@unique([studentId, itemId])` on `StudentCosmetic`, inside the same transaction |
| An achievement reward cannot be bought | refused before the transaction opens |
| A student can only touch their own data | `studentIdOf(userId)` at the top of every method; no id is ever taken from the request |
| A teacher's look needs a real enrolment | `equipAcademy` checks an active enrolment |

Every one of these is covered by a test that **executes** the refusal rather
than asserting it exists.

### Idempotency, and the bug that taught us how to key it

The ledger event is keyed on the **purchase**, not on the (student, item) pair:

```ts
idempotencyKey: `COSMETIC:${cosmeticRow.id}`
```

Keyed on the pair it was permanent. A refund deletes what a student owns but
must not erase the ledger — so the dead row stayed behind, and every later
attempt to buy that item again collided with it. The student was told *"already
owned"* while owning nothing, with no way out.

Ownership is what makes an unlock exactly-once: the unique row dies inside the
transaction before anything is charged. The ledger key only has to be unique.

Refunds use `COSMETIC_REFUND:${rowId}`, which was always keyed this way.

### Buying is not wearing

A purchase does not auto-equip. It opens a dialog offering *"wear it now"* or
*"later"*, because spending is the user's decision and so is changing how their
app looks. Equipping plays a one-off activation sweep, suppressed under
`prefers-reduced-motion`.

---

## 5. Reach — where a personal look goes, and where it stops

It reaches **everywhere the student goes**: the nav, the logo, the messages, a
teacher's profile page, the Learning Centre, the wallet. That is the point of
buying it.

It stops at a **published academy storefront** (`/a/:slug`). That page is the
teacher's shopfront and the first thing a stranger sees of them; it is not
somebody else's to repaint. The rule is held by URL rather than by page, in
`StudioReach` in `App.tsx`, because the rule is about the URL:

```tsx
useEffect(() => { setStudioSuspended(/^\/a\//.test(pathname)); }, [pathname]);
```

Suspending clears the layer and remembers to re-apply it on the way out.

A teacher's own console is untouched for a different reason: a teacher has no
student profile, so there is nothing to apply.

### Verified reach

| Route | Skin |
|---|---|
| `/`, `/learning`, `/studio`, `/messages`, `/profile`, `/wallet` | on |
| `/t/:slug` — a teacher's profile, seen by a student | on |
| `/a/:slug` — a published storefront | **off** |
| the teacher console | **off** (no student layer exists) |

---

## 6. A teacher's look is an item too

The Studio lists the academies a student actually studies at, read fresh, named
for the teacher — *"Amr Farouk's theme"* — so choosing one is as much a tap as
choosing a bought skin. It is free, always owned, and it is the way back after
trying something on.

`academyId` and `themeKey` are mutually exclusive by construction: equipping
either clears the other, because wearing two looks at once is not a thing.

A teacher's row is marked *in use* only when it really is. Marking the first
teacher in use while a bought theme was worn replaced its button with a tick and
took away the one tap back — a dead end, guarded by a test now.

---

## 7. The catalogue

`apps/api/src/studio/studio.catalog.ts` is the single source. It is seeded by
upsert on `key`, so editing a row and redeploying updates it in place.

The catalogue was deliberately **emptied** once (`a997a3e`) after a first pass
the user rejected, with every owner refunded. It is rebuilt one item at a time.

Prices are in **coins**, always. A brief may ask for a theme priced in XP; XP is
progression and is never spent anywhere in this platform — `requiredLevel` is how
it gates instead, so unlocking a theme can never cost a student the level they
earned. "2,499 XP" becomes *"expensive in coins, and gated on a level"*.

### Currently shipped

**الملك المصري / Egyptian King** — `theme-egyptian-king`, LEGENDARY, **100
coins, no level gate**.

| | Night | Day |
|---|---|---|
| ground | `#0a0e16` deep navy | `#f6f2e9` warm chalk |
| surface | `#121722` | `#ffffff` |
| ink | `#dfe2ee` | `#151b28` |
| accent | `#ef4444` | `#dc2626` |
| gold | `#ffb95f` | `#a16207` |

Plus `pattern: 'stadium'` (pitch markings, floodlights, a tactical grid),
`font: 'display'`, `radius: 'sharp'`, `card: 'elevated'`, `button: 'sharp'`.

The daytime gold is chosen to clear its floors **untouched**: a brighter gold
gets darkened into olive, and a medal that looks olive is not a medal.

**وردة اللافندر / Rose & Lavender** — `theme-rose-lavender`, LEGENDARY, **750
coins, level 5**.

| | Night | Day |
|---|---|---|
| ground | `#170f28` deep aubergine | `#fff5f7` blush |
| surface | `#211536` | `#ffffff` |
| ink | `#ede9fe` | `#1e1b4b` |
| accent (lavender) | `#a78bfa` | `#8b5cf6` |
| secondary (rose) | `#fda4af` | `#ff6b8b` |
| "earned" | `#ffb3c1` blush | `#c2185b` deep rose |

Plus `pattern: 'halftone'` (a fine dot field), `glow: true` (two drifting orbs —
lavender in one corner, rose in the other), `font: 'round'`, `radius: 'round'`,
`card: 'glass'`, `button: 'pill'`, `nav: 'floating'`.

**Lavender acts, rose identifies.** Lavender takes the buttons, the active nav,
the links and the progress; rose takes the streak and the chips. Reversing them
gives a pink app with purple buttons, which is the "girly means pink" reading the
theme exists to avoid.

**There is no gold on this theme.** The `gold` slot is still the platform's
"earned" semantic — XP, coins, rank and the level bar all read from it — but here
it holds a rose. That is not decoration: on a pale page a gold has to sit below
roughly `0.28` luminance to clear 3:1 against the deepest card, so anything
bright enough to look like bullion is darkened by the engine and comes back a
copper or a mud-brown, and one warm brown bar makes a page of pink and lavender
look dirty. A deep rose clears the same floors with room to spare.

Earned and the streak are therefore both roses, and are told apart by **depth**:
`#c2185b` against `#ff6b8b` by day. A test holds that gap, and another asserts
red-then-blue channel order at both ends — which fails the moment anyone reaches
for an amber again.

### The ladder

The shop is rungs, and the rung is decided by **how much of the app changes** —
which is also how the price is decided.

| Rung | What it changes | Price | Gate |
|---|---|---|---|
| shapes (`button-*`, `card-*`, `nav-*`) | one slot, app-wide | 60–170 | none |
| marks (`frame-*`, `effect-glow`) | your own avatar / the selected row | 90–450 | level 2–6 |
| earned marks (`frame-scholar`, `frame-fire`, `frame-legendary`) | the same | **not for sale** | an achievement |
| tints (`theme-mint`, `theme-ocean`, `theme-sunset`, `theme-grape`) | accent, second colour, wash, backdrop, typeface, shapes | 220–340 | level 2–4 |
| skins (`theme-paper`, `theme-midnight`) | **the ground as well** | 480–520 | level 4–5 |
| legendary skins (`theme-rose-lavender`, `theme-egyptian-king`) | the same, and meant to be a season's work | 950–1200 | level 6–7 |

The jump between a tint and a skin is the only price step that matters: a tint
changes the light in the room, a skin replaces the room. Everything else follows
from it.

**Rarity is a promise about price.** Each band starts above where the one below
it ends — COMMON 60–130, RARE 170–280, EPIC 320–520, LEGENDARY 950–1200 — and a
test holds the bands apart, because "legendary" meaning 100 coins and 750 at the
same time meant nothing. `theme-egyptian-king` was that 100: priced as a doorway
when the shelf was empty. It is 1200 and level 7 now, the dearest thing in the
shop. Anyone who already owns it keeps it — ownership is a row, and the price is
read only at the moment of purchase.

**Two things are deliberately not sold.** `AVATAR` styles and the `confetti`
effect are names the engine accepts and the stylesheet has never drawn — selling
either would be selling nothing, and a test asserts the catalogue contains
neither. Plain accent colours are not sold either, because mixing one is already
free in the Studio.

### Every theme is held to the floors

`studio.service.spec.ts` sweeps the whole catalogue rather than testing themes
one by one: for each theme, in both modes, body text clears 7:1 on its ground and
4.5:1 on its deepest card, and the brand, accent, second colour and "earned"
families each clear 4.5:1 as a label and as a fill.

It earned its keep immediately. All four tints failed on first run: a theme with
no ground of its own was seated against the platform's **page**, never its
cards — so its accent text measured about 4.0:1 on the surface most of the
product's text actually sits on. `PLATFORM_SEAT` in `studio-theme.ts` now gives
the default ground the same deepest-panel seat `surfaceSeat` already gave skins.

### A preview shows the thing, not its name

Non-theme items had no drawing at all: the card printed the style's own value —
`pill`, `paper` — so a whole rung advertised itself with an internal English
identifier on an Arabic page. The first replacement drew each shape honestly and
was still wrong, because six buttons differing by four pixels of corner is not a
choice anyone can make from a grid.

`StylePreview` now draws one property, large, exaggerated to the edge of honesty:
a single wide button so the corner is unmistakable, a card with its real radius
and shadow, three menu rows with the selected one shaped and spaced as that nav
style would shape and space it. Frosted glass gets a coloured shape behind it,
because translucency over a flat colour is invisible. The radii are the
stylesheet's own; only the scale is generous.

### Frames were invisible

Every frame was drawn on `.studio-frame::after` at `inset: -4px`, inside an
element with `overflow: hidden` to clip the avatar photo — so the ring was
clipped away by the very box it was meant to go around, on every screen, for
every frame. They are `box-shadow` now, which is painted outside the border box
and is not subject to the element's own overflow. The frame also follows the
student to the top bar and the sidebar, rather than appearing only in the Studio.

### The second colour has a job

Until this theme, `--s-secondary` was derived by the server, exposed in Tailwind
as `student-secondary-*` — and used by exactly one rule in the whole app: the
second background orb. A theme could name two colours and only ever show one.

The **streak** is now that job. Coins and rank are winnings and stay gold; a
streak is a habit — not spent, not ranked, not won — and painting it gold put
three golds in a row and made the level card one colour. It reads from the
theme's second colour instead, on the level card, the at-risk banner and the
Studio's own stat row. With no theme equipped it falls back to the academy's
`--c-secondary`, so nothing changes for a student who has bought nothing.

### Gold as a semantic

Gold is not a third accent. XP, coins, trophies, rank, level progress, mission
rewards and achievements all read from it, so *"this was earned"* has one colour
across the whole app instead of an amber hard-coded into each component that
happened to need one. Pulling those out of the accent is also what keeps red to
roughly a tenth of the screen.

A payment warning is **not** an earned value and stays amber.

---

## 8. API

All under `/api/v1/student/studio`, all student-only.

| Method | Path | Does |
|---|---|---|
| `GET` | `/` | the whole Studio: balance, what is worn, the catalogue, the teachers' looks |
| `GET` | `/theme` | just the derived tokens, for boot |
| `POST` | `/unlock` | buy — `{ key }`, price from the catalogue |
| `POST` | `/equip` | wear an owned item |
| `POST` | `/equip-academy` | wear a teacher's look |
| `POST` | `/unequip` | take one slot off |
| `POST` | `/accent` | a hex colour of your own |
| `DELETE` | `/customization` | back to the academy's look; **owns nothing less** |

Reset clears every slot and touches nothing that was earned — collection, XP,
coins and badges all survive. Stated in the UI, asserted in a test.

---

## 9. Files

| File | Holds |
|---|---|
| `apps/api/src/studio/studio-theme.ts` | every derivation and every floor. The only place a colour is decided |
| `apps/api/src/studio/studio.catalog.ts` | the items, as data |
| `apps/api/src/studio/studio.service.ts` | ownership, the economy, the guards |
| `apps/api/src/studio/studio.service.spec.ts` | 52 tests — the money, the floors, the allowlist, the reach |
| `apps/web/src/lib/studio.ts` | `paint()`, the allowlist, `written[]`, suspension, the activation sweep |
| `apps/web/src/pages/student/StudioPage.tsx` | the shop |
| `apps/web/src/components/BrandTheme.tsx` | which academy the app wears |
| `apps/web/src/index.css` | what each shape name and pattern name *means* |
| `apps/web/tailwind.config.ts` | the token wiring, including the fill/label split |

---

## 10. Things not to do

Carried from the original brief and from what went wrong since:

- **Do not let the frontend decide a price, a balance, or a colour.**
- **Do not blanket-clear the allowlist** — only remove what this layer wrote.
- **Do not create a second economy** or a second XP system.
- **Do not create a third theme engine.** Academy branding and student
  personalisation are the two; a third would have to agree with both.
- **Do not allow `customCss`, `customHtml`, or `customJavascript`.** Ever.
- **Do not create gambling mechanics.** No loot boxes, no randomised rewards.
  Rarity says how much effort something took, never how likely it is.
- **Do not ship a likeness, a club badge, or a named person or character.** The
  palettes and patterns carry the feeling; the names and marks belong to
  somebody else.
