# Darsly — UI Conventions

The rules the interface is actually held to. Most of them exist because
something broke in production first; each one says which, so nobody has to
rediscover it.

The product is **Arabic-first**: Egyptian Arabic, full RTL, EGP. English is the
fallback, not the design target.

---

## 1. Never write a colour literal

Every colour resolves through a CSS custom property. That is what lets a
teacher's published palette and a student's theme repaint the app at runtime
without a per-screen edit.

```html
<!-- yes -->  <div className="bg-surface-container-lowest text-on-surface">
<!-- no  -->  <div className="bg-white text-slate-900">
<!-- no  -->  <div style={{ color: '#4a32c9' }}>
```

The literals live in exactly one place — `apps/web/src/index.css` — as the
platform default. See [STUDIO.md](./STUDIO.md) for the two layers on top.

### Semantic, not decorative

Pick the token that says what the thing *is*:

| Meaning | Token |
|---|---|
| an action, a link, the brand | `primary` / `student-accent` |
| something **earned** — XP, coins, rank, trophies, achievements | `student-gold` |
| something went wrong | `error` |
| the page | `background` |
| a card on it | `surface-container-lowest` |
| body text | `on-surface` |
| secondary text | `on-surface-variant` |
| the quietest text | `outline` |

Gold is a semantic, not a third accent. If you hard-code an amber because a
component happened to need one, the next theme will not know about it.

A **payment warning is not an earned value** and stays amber.

### Fill and label are different tokens

`bg-primary` is a fill (floor 3:1) and `text-primary` is a label (floor 4.5:1).
They are separate variables and Tailwind re-points only the text utility. Do
not "fix" one by changing the other.

---

## 2. Contrast floors are not negotiable

| What | Floor |
|---|---|
| body text | **7:1** (AAA) |
| secondary text, outlines, any colour used as a label | **4.5:1** |
| text on a filled control | **4.5:1** |
| a fill, a bar, a border | **3:1** |

Enforced on the server by `legible()`, which moves a colour until it clears,
and verified in a browser by measuring **every text node against its own
computed background**. A unit test cannot catch a token that is fine in
isolation and fails on the surface it is actually drawn on.

Two real misses, both found by measuring rather than by reading:

- gold on its own navy at **4.12:1**, because it was floored against the
  *platform's* ground instead of the skin's
- brand text at **4.43:1** on a card, because it was floored against the page
  rather than the deepest panel

### The pairing that was wrong 48 times

`bg-primary-fixed` is a soft fill, and the text on it is `text-on-primary-fixed`
— a token floored against that fill. It was paired with `text-primary` (floored
against the *page*) in 48 places across the app, which measured 3.47:1.

---

## 3. Nothing may widen the page

> A grid track and a flex item both size to their content unless told
> otherwise.

One child that cannot get narrower — a card carrying its padding, a label that
will not wrap — sets the width of its column, the column sets the width of the
page, and everything beside it is pushed off the edge.

The base layer says otherwise:

```css
.grid > *, .flex > * { min-width: 0; }
h1, h2, h3, h4, p, li, dd, dt, figcaption, blockquote { overflow-wrap: break-word; }
@media (max-width: 26rem) { .card, .studio-card { padding: 0.875rem; } }
```

It is in `@layer base`, so any `min-w-*` utility still overrides it and the
horizontal scrollers keep working.

### What to avoid

- **`shrink-0` on a container that holds content.** It stops that container
  shrinking, so its max-content width becomes the page width. The page header's
  action slot did exactly this: two buttons on the teacher dashboard set the
  width of the whole document. It is now `w-full shrink-0 sm:w-auto`.
- **A hard `min-w-[…]` without a breakpoint.** Write `sm:min-w-[9rem]`.
- **A fixed `w-*` on anything that must survive a phone.**

### Deliberate horizontal scrolling

A row that is *meant* to scroll sideways uses `.scroll-x`: it hides the
scrollbar and fades both edges below 40rem, so a row cut off mid-word reads as
*more to swipe to* rather than as a broken layout.

```html
<div className="scroll-x -mx-6 px-6 sm:mx-0 sm:px-0">
  <div className="inline-flex min-w-full gap-1">…</div>
</div>
```

---

## 4. Widths to test at

| Width | Why |
|---|---|
| **412 / 393** | a normal Android phone at default display size |
| **360** | a smaller phone, or a normal one with display size up one notch |
| **320** | a normal phone with Android's display size near its maximum |
| **280** | the floor the layout is held to |

**Android's display-size setting narrows the CSS viewport.** A 412px phone can
report 320. This is the single most common reason a layout "works on my machine"
and is cut off for a real user, and it is how the two-up grids were found
broken.

Test in **both languages**. `scrollWidth - clientWidth` under-reports in RTL, so
measure each element's rect against the viewport *and* against the box meant to
contain it.

Disable animations when measuring (`reducedMotion: 'reduce'`) and scroll the
page first — an element caught mid-reveal reports a transform, not a bug.

---

## 5. RTL

- Use **logical properties**: `ms-*` / `me-*` / `ps-*` / `pe-*` / `start-*` /
  `end-*`. Never `ml-*`, `mr-*`, `left-*`, `right-*`.
- `<html dir>` is set from the language in `apps/web/src/i18n/index.ts`.
- Numbers, progress bars and anything read left-to-right regardless carry
  `dir="ltr"` locally.
- A name or a title that could be either script goes in `<bdi>`.

---

## 6. Typography and shape

- **Display / headings**: Rubik. **Body**: IBM Plex Sans Arabic. Both
  Arabic-native, chosen over the Tajawal/Inter default pairing.
- A theme may swap the pairing, but **every stack ends in the Arabic face** — an
  English display font has no Arabic glyphs.
- **One radius**, 12px. `rounded-full` for pills and avatars is the only
  sanctioned exception. A theme may change the radius globally by name.
- **Hairlines, not shadows.** Default separation is `0 0 0 1px`. The only two
  real shadows are `elevated` (hover lift) and `modal` (popovers).
- Never pure `#000` or `#fff` — paper and ink.

---

## 7. Icons

Material Symbols, via a ligature: the element's text content *is* the icon name.

**The trap**: before the font loads, the browser lays out
`account_balance_wallet` as words and the layout jumps. Three things prevent it,
and all three are needed:

1. `width: 1em; overflow: hidden` on the glyph
2. `&display=block` on the font URL, so an icon is never painted in a fallback
   face
3. a `<link rel="preload">`, because until it lands every icon is blank

A consequence worth knowing when testing: `innerText` returns the ligature name,
so a button reads as `"paid\nUnlock for 100"`. That is not a bug.

---

## 8. Motion

Shared primitives in `index.css` rather than a bespoke animation per page, so a
reward moment feels the same wherever it happens:

`.s-rise` `.s-shine` `.s-pop-in` `.s-arc` `.s-sweep` `.s-activation`

Transform and opacity only — both composite on the GPU and neither forces a
layout. **Every one is disabled under `prefers-reduced-motion: reduce`**, in one
place.

---

## 9. Stacking

`#root` is `position: relative; z-index: 0; isolation: isolate`, and the themed
backdrop sits at **`z-index: -1`** inside it.

Not zero. A positioned element at `z-index: 0` paints *after* the ordinary
in-flow content around it, so at zero the backdrop sat on top of every card and
its opaque vignette quietly erased whatever text fell under the curve. Raising
`#root` above it cannot help — the backdrop lives inside `#root`, so it comes
along.

---

## 10. Before you say it works

1. `npx tsc --noEmit` in `apps/web`
2. `npm run check:web` — every internal link resolves to a real route, and the
   ar/en translations are complete on both sides
3. `npx jest` in `apps/api`
4. **Open it in a real browser.** At 1440, at 393 and at 320, in both languages,
   in both light and dark. Measure contrast and overflow rather than looking.
5. Check the console. Zero errors.

A screenshot of a page mid-animation is not evidence, and neither is a passing
unit test for anything about colour or layout.
