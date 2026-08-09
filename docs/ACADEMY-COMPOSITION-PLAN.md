# Academy Site Generator → Composition Architecture
### Implementation plan (planning only — no code changed)

Verified against `apps/api/src/academy-site/**` at `de1a663`.

---

## 1. Current architecture — findings

### 1.1 The pipeline as it actually runs

`SiteGeneratorService.buildDraft()` (`generation/site-generator.service.ts:46`):

1. **extract** — `Academy` + `AcademyProfileFacts` + `AcademyMedia(status=READY, kind∈{LOGO,COVER,GALLERY})`.
   Builds `ContentSignals` (`generation/plan-prompt.ts:6`): 6 fields —
   `hasCover, hasLogo, galleryCount, bioLength, subjectsCount, achievementsCount`.
   **Nothing about courses, reviews, prices or image aspect ratios is ever read.**
2. **evolution** — `EvolutionService.context()` → `{publishedDna, publishedArchetype, recentDnas[≤5], regenCount}`.
3. **PLAN (AI call 1)** — strict JSON Schema `planningJsonSchema`. Output:
   `designDNA` (enum of 7), `theme.primary/accent` (hex strings, *not* regex-validated in the JSON schema),
   `archetype` (enum of 6), `design{background, ink, surface, radius 0–28, density×3, headingScale×3, heroTreatment×4, bodyFont×3, motion×3}`.
   `maxTokens: 1500`, `reasoning.effort: 'low'`.
4. **DNA resolution** — `normalizeDna()` → `resolveDna()` (`pipeline/design-dna.ts`, 7 DNAs) → `{preset, style, headingFont, palette}`.
   `pickVibeDna(vibe, regenCount)` is only a fallback.
5. **RULES** — `DesignRulesService.validatePlan()`: exactly two rules (display→sans for academic preset; a `no-media` warning). **It does not validate `plan.design` at all.**
6. **GENERATE (AI call 2)** — `aiCopyJsonSchema` → fixed-shape copy: `seo, hero, about, toolkitHeading+highlights, credentialsHeading+credentials, faq, cta`.
7. **assemble()** — a hard-coded block list: hero, about, toolkit?, credentials?, courses, gallery?, reviews, faq, contact.
8. **`brain.arrange(doc, archetype)`** — permutes the middle band via a static priority table (`site-brain.service.ts:15–27`).
9. **`brain.assignVariants(doc, ctx)`** — `selectVariant()` scores registered variants.
10. **`parseSiteDocument()`** (zod) → `saveDraft()` → `AcademySite.draftDoc` + `AcademySiteSnapshot(reason='generate')`.

### 1.2 Render / publish

`SiteRenderService.compile()` → `brain.plan(doc)` → `RenderPlan{theme, seo, blocks[{block, variant}], verdicts}` → `compileSite(plan, ctx)`.

`compileSite()` (`renderer/site-compiler.ts`, 582 lines) emits one self-contained HTML doc: **one monolithic ~260-line CSS string** + **one monolithic inline JS**. Every page gets the entire stylesheet and the entire script regardless of what it uses.

`publish()` bakes HTML into `AcademySite.publishedHtml` and *also* copies `theme.primary/accent/design` onto `Academy.colorPrimary/colorAccent/brandTokens`, which the React console reads in `apps/web/src/components/AcademyProvider.tsx:22–33`. **The design model is therefore a cross-surface contract, not just a page concern.**

### 1.3 Where "template-like" actually comes from

The `design` object is genuinely expressive-ish for a *palette*, but it only reaches:
- 4 CSS custom properties (`--bg/--ink/--surface/--card`) via `aiPalette()`
- `--rad`, `--pad` (`DENSITY_PAD`), `--h2` (`HEADING_SCALE`), `--body-font` (`BODY_STACK`)
- one `switch` in `heroBackdrop()`
- one `data-motion` attribute driving ~20 lines of amplitude overrides

**Everything else is fixed**: the grid, the container width (`1120px`), section rhythm, card treatment, the numbered eyebrow, the reveal choreography, the hero aura, the gallery mosaic, the social pills. Two academies with different palettes are the *same page in different paint* — which is precisely the failure mode described in the plan prompt (`plan-prompt.ts:44`) and not actually prevented by anything downstream.

### 1.4 Concrete gaps found (independent of the redesign)

| Finding | File |
|---|---|
| `EvolutionService.enforceVariety()` is **dead code** — never called anywhere | `pipeline/evolution.service.ts:65` |
| Nothing validates the AI's `ink`/`background` contrast, despite the prompt demanding 7:1. A hostile-or-unlucky plan ships an illegible page. `DesignRulesService.check()` only lints `primary`/`accent`. | `pipeline/design-rules.service.ts:62` |
| `stats` block type is in the schema and has a renderer, but `assemble()` **never emits one** | `generation/site-generator.service.ts:229` |
| `cta` likewise (deliberately removed in `de1a663`, renderer kept) | same |
| `hasAboutImage` is hard-coded `false`; `about` blocks never get a `mediaId` | `site-generator.service.ts:167` |
| Variants returning `''` (toolkit/credentials/gallery with no items) leave a **gap in the CSS section counter** (`counter-increment: sec` runs on the block class, but the block never renders) | `renderer/variants/defaults.ts:155` |
| Only 12 variants exist; 8 of 11 section types have exactly **one** | `renderer/variants/defaults.ts` |
| `planningJsonSchema` declares `theme.primary` as plain `string` — the hex check happens later in zod, and on failure the whole plan is `RETRYABLE` rather than repaired | `generation/planning.jsonschema.ts:21` |
| The entire subsystem has **one** spec file (`site-compiler.spec.ts`). No tests for the brain, rules, evolution, quality gate or generator. | — |

Budget *is* enforced (`jobs/ai-job.service.ts:54`), moderation and media ownership are solid, and the security posture is genuinely good: the AI emits only enums, bounded ints and hex, and all copy passes `escapeHtml`. **Any richer DSL must preserve that invariant exactly.**

---

## 2. Target architecture

```
Facts + Media + LiveContent + History
  → CONTENT PROFILE        (deterministic; replaces ContentSignals)
  → CAPABILITY BRIEF       (deterministic; what this teacher's content unlocks)
  → AI PLAN                (proposes: SiteComposition — design system + section composition)
  → SCHEMA VALIDATION      (zod: types/bounds/enums)
  → CAPABILITY RESOLUTION  (registry: unknown ids → nearest supported, never reject)
  → DESIGN RULES           (contrast, coherence, motion/complexity budget → repair)
  → CONTENT-FIT RULES      (pattern requirements vs profile → downgrade)
  → SITE BRAIN             (authoritative ResolvedComposition)
  → AI COPY                (slot-driven: writes exactly the text the composition needs)
  → assemble → SiteDocument (frozen, versioned)
  → PURE COMPILER          (composition → HTML + on-demand CSS/JS modules)
  → EVOLUTION STORE        (design fingerprint feeds the next plan)
```

Three architectural commitments:

1. **The AI never emits a string that reaches markup unescaped, a URL, a class name, or CSS.** It emits enums, bounded numbers, hex colors, content-binding references and ids of existing registry entries. This is the same guarantee as today, held at a much larger vocabulary.
2. **Repair, never reject.** Validation layers *downgrade* to the nearest supported thing and record a verdict. Only an unparseable response is retryable. Today a single bad hex fails the whole generation.
3. **Two-tier composition.** Patterns (hand-built, high-quality, ~90% of sections) + a bounded composition tree (hero and up to 2 feature sections). Unbounded node trees are where design quality dies; pattern-only is where sameness lives. Two tiers gets both, and the Tier-2 budget can grow as confidence grows.

---

## 3. Proposed data model

### 3.1 `DesignSpec` — evolves `siteThemeSchema.design`

Every field optional and additive, so pre-v3 documents render byte-identically.

```ts
DesignSpec {
  palette: {
    background, ink, surface, surfaceAlt, primary, accent   // #RRGGBB
    mode: 'light' | 'dark'                                   // AI states it; validator checks it
    // derived by the compiler, never by the AI:
    // onPrimary, muted, hairline, body, gradient stops
  }
  typography: {
    headingFamily: 'sans'|'serif'|'display'|'mono'|'condensed'
    bodyFamily:    'sans'|'serif'|'mono'
    scale:         'restrained'|'balanced'|'dramatic'|'monumental'
    headingWeight: 400|500|600|700|800|900
    headingCase:   'normal'|'upper'
    tracking:      'tight'|'normal'|'wide'
    measure:       'narrow'|'normal'|'wide'
  }
  geometry: {
    radius: 0..32
    radiusStyle: 'uniform'|'mixed'|'pill'|'cut-corner'
    border: 'none'|'hairline'|'strong'
    shadow: 'none'|'soft'|'deep'|'brutal'
    grain: boolean
  }
  rhythm: {
    density: 'compact'|'regular'|'airy'|'expansive'
    sectionRhythm: 'even'|'alternating'|'crescendo'
    containerWidth: 'narrow'|'standard'|'wide'|'full'
    gutter: 'tight'|'normal'|'generous'
  }
  motion: {
    intensity: 'calm'|'lively'|'cinematic'
    entrance: 'fade'|'rise'|'slide'|'mask-reveal'|'stagger-grid'
    scrollFx: ('parallax'|'sticky-headings'|'progress-bar'|'counters'|'pointer-glow'|'marquee')[]  // ≤3
  }
  decoration: {
    background: 'none'|'gradient-wash'|'mesh'|'spotlight'|'grid-lines'|'dot-matrix'
              |'blueprint'|'topography'|'orbits'|'aurora'
    accents: ('rule-lines'|'numbered-sections'|'corner-brackets'|'sticker-badges'
             |'underline-swash'|'blob'|'ring')[]   // ≤3
    dividers: 'none'|'hairline'|'gradient'|'wave'|'notch'
    imageTreatment: 'plain'|'rounded'|'duotone'|'ring'|'tilt'|'mask-arch'|'mask-blob'|'grid-overlay'
  }
}
```

The existing 7 fields map forward losslessly: `density`→`rhythm.density`, `headingScale`→`typography.scale`, `heroTreatment`→`decoration.background`, `radius`→`geometry.radius`, `bodyFont`→`typography.bodyFamily`, `motion`→`motion.intensity`, `background/ink/surface`→`palette.*`. Write the migration as a pure function `liftLegacyDesign(v2) → DesignSpec` so old documents get the new renderer for free.

### 3.2 `SectionSpec` — replaces the bare `variant?: string` on each block

```ts
SectionSpec {
  pattern: PatternId            // 'hero.split-portrait', 'courses.bento', …
  emphasis: 'quiet'|'normal'|'feature'
  width:   'narrow'|'standard'|'wide'|'full'
  surface: 'page'|'raised'|'inverted'|'accent'|'image'
  align:   'start'|'center'
  columns?: 1|2|3|4
  decoration?: AccentId[]        // ≤2, drawn from the global vocabulary
  media?: { mediaId: string; treatment: ImageTreatment }
  composition?: CompositionNode  // Tier 2 only
}
```

`variant?: string` stays in the schema as the v2 alias; `resolveVariantId()` keeps working.

### 3.3 New block types

`timeline`, `process`, `skill-matrix`, `quote`, `feature-split`, `metric-band` — all pure presentation blocks with the same bilingual-text discipline as today. `stats` finally gets generated.

### 3.4 Document versioning

```ts
SiteDocument {
  version: 1                     // unchanged (the zod literal)
  renderer?: { version: number } // NEW — which compiler generation designed this
  theme: SiteTheme               // + design: DesignSpec
  composition?: { fingerprint: DesignFingerprint; rationale?: string }
  seo?, blocks: SiteBlock[]      // blocks gain `section?: SectionSpec`
}
```

`renderer.version` is the determinism anchor: a document always compiles the way it was designed. `recompilePublished()` gains an explicit target version so upgrades are a deliberate, audited action rather than a side effect of deploying.

### 3.5 Persistence changes (all additive)

- `AcademySiteSnapshot.fingerprint Json?` — the design fingerprint for evolution.
- `AcademySiteSnapshot.rationale String?` — the model's one-line design reasoning, for the Studio UI.
- No changes to `AcademySite`, `AcademyMedia`, `AiJob`.

Both are nullable adds — safe against non-empty prod tables (per `[[prisma-migration-safety]]`).

---

## 4. The UI DSL

### 4.1 Tier 1 — patterns + slots (default)

A **pattern** is a hand-built, registered layout with named slots. It is the evolution of today's `registerVariant`:

```ts
registerPattern({
  id: 'credentials.timeline',
  section: 'credentials',
  slots: ['heading', 'items'],
  requires: { achievementsCount: { min: 4 } },
  weight: { archetype: { exam_prep: 1.4, university: 1.3 }, default: 1.0 },
  css: () => TIMELINE_CSS,          // emitted only if used
  render: (block, spec, ctx) => …,
})
```

Registration-order default and `score(ctx)` selection are preserved, so `registry.ts` needs additive changes only.

Proposed pattern library (target ≈40, up from 12):

| Section | Patterns |
|---|---|
| hero | centered · split-portrait · editorial-statement · image-full · bento-hero · offset-collage |
| about | side-by-side · statement · two-column-editorial · portrait-quote |
| toolkit | tags · skill-matrix · icon-grid · marquee-band |
| credentials | numbered-list · cards · timeline · achievement-wall |
| stats | band · big-numbers · inline-strip |
| courses | grid · bento · carousel-rail · featured-plus-list |
| reviews | cards · quote-wall · single-spotlight |
| gallery | mosaic · immersive-full-bleed · masonry · filmstrip |
| faq | accordion · two-column · numbered |
| contact | pills · split-cta · footer-band |
| timeline / process / quote / feature-split | 2–3 each |

### 4.2 Tier 2 — bounded composition tree (hero + ≤2 feature sections)

```ts
type CompositionNode = Container | Primitive | BusinessComponent

Container = {
  kind: 'Stack'|'Row'|'Grid'|'Bento'|'Overlay'
  gap?: 'none'|'xs'|'sm'|'md'|'lg'|'xl'
  align?: 'start'|'center'|'end'|'stretch'
  justify?: 'start'|'center'|'end'|'between'
  columns?: 1..4            // Grid/Bento
  span?: 1..4               // as a child of Grid/Bento
  rowSpan?: 1..2
  order?: 0..12
  padding?: 'none'|'sm'|'md'|'lg'
  surface?: 'none'|'raised'|'inverted'|'accent'|'glass'
  at?: { md?: Partial<Container>; lg?: Partial<Container> }   // responsive, bounded
  children: CompositionNode[]
}

Primitive =
  | { kind:'Heading', level:1|2|3, bind:ContentRef, treatment?:'plain'|'gradient-tail'|'outline'|'highlight' }
  | { kind:'Text',    bind:ContentRef, size?:'sm'|'md'|'lg'|'lead' }
  | { kind:'Eyebrow', bind:ContentRef }
  | { kind:'Badge',   bind:ContentRef, tone?:'accent'|'neutral'|'live' }
  | { kind:'Button',  bind:ContentRef, role:'primary'|'secondary'|'ghost' }   // href owned by platform
  | { kind:'Image',   mediaId:string, treatment?:ImageTreatment, ratio?:'1:1'|'4:3'|'3:4'|'16:9'|'auto' }
  | { kind:'Shape',   shape:'blob'|'ring'|'grid'|'arc'|'dots', scale?:'sm'|'md'|'lg' }
  | { kind:'Divider', style?:DividerStyle }
  | { kind:'Stat',    index:number }
  | { kind:'Icon',    name:IconId }        // closed icon set
  | { kind:'Spacer',  size:'sm'|'md'|'lg' }

BusinessComponent =
  | { kind:'CourseList',  limit:1..12, layout:'grid'|'rail'|'list'|'bento' }
  | { kind:'ReviewList',  limit:1..12, layout:'cards'|'wall'|'spotlight' }
  | { kind:'EnrollButton', role:'primary'|'secondary' }
  | { kind:'PriceBadge' }
  | { kind:'SocialLinks', layout:'pills'|'icons'|'stacked' }
  | { kind:'GalleryStrip', mediaIds:string[], layout:'mosaic'|'masonry'|'filmstrip' }
```

`ContentRef` is a **reference**, never a string: `{ field: 'hero.headline' }`, `{ field: 'toolkit.items', index: 2 }`. The AI cannot inject text through the composition — text arrives only from the COPY stage and only through `escapeHtml`/`i18n`.

Bounds: depth ≤ 3, ≤ 24 nodes per section, ≤ 3 Tier-2 sections per page, ≤ 2 `Overlay` per page, ≤ 6 `Shape` total.

### 4.3 Responsive

The `at: { md, lg }` map on containers only. Base is mobile. The compiler emits the media/container queries; the AI never sees a pixel value. Any pattern or container that would produce >2 base columns is rejected by the rules engine, not by hoping.

### 4.4 How this composes into genuinely different pages

The expressive surface is the product of: **palette mode × typographic system (5×4×6 families/scales/weights) × geometry × background decoration (10) × section list & order × pattern per section (≈4 each) × per-section surface/width/emphasis × Tier-2 hero tree**. That is not "more enums" — it is a different *page structure* per teacher, with the visual language attached to it.

---

## 5. AI responsibilities

### PLAN (call 1) — grows substantially

Produces one `SiteComposition`:
- `archetype`
- `designSpec` (§3.1) in full
- `sections: { type, pattern, emphasis, width, surface, align, columns?, decoration?, mediaRole? }[]` — **including which sections exist and in what order**
- `composition` trees for the hero and up to 2 nominated feature sections
- `contentPlan`: how many stats, timeline entries, matrix cells the page wants (drives the COPY call)
- `rationale`: ≤200 chars, stored and shown in the Studio, never rendered as markup

Token budget: raise `maxTokens` 1500 → ~6000 and `reasoning.effort` low → medium. Cost roughly doubles per generation; still cents, and `assertWithinBudget()` already gates it.

### COPY (call 2) — becomes slot-driven

Today the schema is a fixed shape. It becomes: "the plan asks for a 4-item stats band, a 5-entry timeline, a 6-cell skill matrix" → the JSON schema is **generated from the plan** (it is already built programmatically in `ai-copy.jsonschema.ts`, so this is a natural extension). This is what finally makes `stats` and the new section types carry real content.

### Never AI

Derived colors · CSS/JS emission · breakpoints · RTL · reduced-motion · which live data is fetched and its URLs · price/fee computation (`StudentPriceService`) · CTA destination and `target="_top"` (`site-compiler.ts:39–42`) · anchors · media resolution and ownership · language toggle · SEO tags · sitemap · hydration endpoints.

---

## 6. Validation boundaries

| Layer | Where | Behavior on failure |
|---|---|---|
| 1. Transport | OpenAI strict JSON Schema | provider-enforced |
| 2. Structural | `composition.schema.ts` (zod) | unparseable → RETRYABLE (as today) |
| 3. Capability resolution | `CapabilityRegistry` | unknown pattern/component/effect → nearest supported + verdict |
| 4. Semantic design | `DesignRulesService` v2 | repair (adjust ink, drop an effect, cap a scale) + verdict |
| 5. Content-fit | `ContentFitRules` | downgrade to best-scoring alternative pattern |
| 6. Complexity budget | `CompositionBudget` | deterministic prune: decoration → Tier-2 → sections |
| 7. Business | existing `assertMediaOwnership`, claims, moderation, quality gate | throw (unchanged) |
| 8. Compile | compiler is total | any node reaching it has a renderer by construction |

Semantic rules to add (layer 4), all of which are missing today:
- `ink`↔`background` ≥ 7:1 body, ≥ 4.5:1 large — **repair** by nudging ink toward the extreme rather than failing
- `surface`↔`background` ΔL within a band (not identical, not a second theme)
- `onPrimary` contrast on every button surface, incl. `surface: 'inverted'` sections
- accent distinguishable from primary (exists) and from surface (new)
- `monumental` + `upper` + `tight` + `condensed` → cap the scale
- `scrollFx` ≤3; `marquee` + `parallax` + `cinematic` together → drop the last
- ≤2 heavy background decorations across the page
- no 3 consecutive sections with the same `surface`
- `containerWidth: 'full'` requires a pattern that declares full-bleed support

Every verdict is already carried on `RenderPlan.verdicts` — surface them in the Studio (they are currently computed and logged at debug level only).

---

## 7. Renderer / compiler changes

Split `site-compiler.ts` (582 lines) into modules with **on-demand emission**:

```
renderer/
  compile.ts             # orchestrates; still pure, still one HTML doc
  css/
    tokens.ts            # DesignSpec → :root custom properties (the ONLY place hex lands)
    base.ts              # reset, container, typography scale, RTL
    patterns/*.ts        # one module per pattern — emitted only when used
    effects/*.ts         # decoration + motion modules — emitted only when used
  js/
    core.ts              # lang toggle, hydration, reveal (always)
    effects/*.ts         # parallax, counters, pointer-glow, marquee — only when used
  nodes/                 # Tier-2 primitive renderers
  patterns/              # pattern renderers (today's variants/defaults.ts moves here intact)
  components/            # CourseList, ReviewList, EnrollButton, PriceBadge, SocialLinks
```

On-demand emission is the direct answer to "we should not duplicate arbitrary code into every site": today every page ships the full stylesheet and full script including the aura, the tilt, the counters and the mosaic whether or not it uses them. After the split, a calm typographic page ships a fraction of the CSS.

`compileSite(plan, ctx)` stays pure and synchronous. `SiteRenderService` is unchanged. `RenderPlan` gains `design: DesignSpec` and `blocks[].section: SectionSpec`.

---

## 8. Component system

**Reuse as-is:** the whole `registerVariant`/`selectVariant`/`resolveVariantId` machinery (`renderer/variants/registry.ts`) — it already models an open catalogue with scored selection and a safe default. Rename to patterns, keep the semantics. All 12 existing variants become patterns unchanged, which is what keeps existing documents byte-identical.

**Reuse:** `shared.ts` helpers (`i18n`, `headline`, `head`, `skeleton`), `html.util.ts`, `color.util.ts`, `text.util.ts`. These are the safety layer and they are good.

**New:** `ComponentRegistry` with declared props schemas + `requires` (content requirements) + `cost` (complexity weight). Business components are the only things allowed to emit `data-hydrate`, and they take **no AI-supplied href, endpoint or query**.

**New:** `PatternRegistry` entries carry `requires`, `weight` (per-archetype), `cssModule`, `jsModules`, `supportsFullBleed`, `mobileBehavior`.

---

## 9. Freedom vs control — the boundary

**AI owns (inside the sandbox):** palette · typography system · geometry · shadow/border language · rhythm and density · section list, order and repetition · pattern per section · per-section surface/width/emphasis/alignment · decoration and background treatment · image treatment · entrance and scroll effects (from a closed set, budgeted) · hero and feature-section composition trees · content quantity plan · copy.

**Platform owns (never negotiable):** authentication · enrollment · payments and the fee split · database access · secrets · every URL and endpoint · authorization · the hydration contract · escaping · media ownership · moderation and takedown · CSP and iframe escaping · reduced-motion · RTL correctness · SEO/sitemap · what data exists at all.

The boundary is enforced *structurally*, not by prompt: the AI's output type system has no field that can hold a URL, a class name, CSS, a script, or unescaped text. That property is testable, and §14 makes it a test.

---

## 10. Subject-aware design

Archetypes become **weighted profiles**, not templates:

```ts
ArchetypeProfile {
  paletteHints:  { modeBias, hueFamilies }
  typographyHints: { familyWeights, scaleBias }
  decorationVocabulary: BackgroundId[]     // what the prompt showcases first
  patternWeights: Record<PatternId, number>
  sectionPriorities: Record<BlockType, number>   // today's ARCHETYPE_ORDER, generalized
  discouraged: PatternId[]                  // never suggested; not forbidden
}
```

- `programming` → `grid-lines`/`dot-matrix`/`blueprint` in vocabulary, mono body plausible, sharp radius weighted up, `toolkit.skill-matrix` and `courses.bento` weighted up.
- `languages` → `creative_serif` lineage, `mask-arch` imagery, `reviews.quote-wall` weighted up, warm light modes.
- `exam_prep` → `credentials.timeline`, `stats.big-numbers`, `metric-band`, high-energy motion.
- `math_science` → `academic_precise` lineage, `topography`, `process` sections, restrained motion.

These bias (a) what the prompt shows first, (b) tie-breaks in `selectVariant`, (c) the rules engine's "unusual but allowed" threshold. Nothing is hard-filtered except `discouraged`, and even that only suppresses *suggestion*.

**Anti-sameness guarantee:** the diversity signal in §11 operates *within* archetype — two programming teachers are explicitly pushed apart, which no mechanism does today.

---

## 11. Content-aware composition + evolution

### `ContentProfile` (replaces `ContentSignals`)

```ts
ContentProfile {
  media: { hasCover, coverRatio, hasLogo, galleryCount, galleryRatios }
  text:  { bioLength, bioParagraphs, subjectsCount, achievementsCount, avgAchievementLength }
  live:  { publishedCourseCount, priceMin, priceMax, reviewCount, avgRating }   // NEW — needs queries
  derived: { sectionWeight: Record<BlockType, 0..1>, evidenceStrength: 'thin'|'normal'|'strong' }
}
```

The `live` block is the missing piece: today the generator never queries `Course` or `Review`, so it cannot know a teacher has 12 courses or none. Add two cheap counts in `buildDraft()`'s extract step. That is what makes "many courses → course-focused composition, few courses → avoid course-heavy layouts" possible at all.

The profile is used twice, on purpose:
1. **In the prompt** as a *capability brief* — "`gallery.immersive` is unavailable to you (2 images)" — for quality.
2. **In the validator** as a hard gate — for safety, regardless of what the model returns.

### Evolution — design fingerprints

Replace the single DNA string with:

```ts
DesignFingerprint {
  paletteMode, hueFamily, headingFamily, scale, radiusBand, densityBand,
  backgroundDecor, heroPattern, sectionOrderHash, tier2Count
}
```

Stored on `AcademySiteSnapshot.fingerprint`. The plan prompt receives: the published fingerprint ("what they kept — you may refine it"), the last 3 fingerprints ("do not repeat these axes"), and — new — **fingerprints recently used by other academies in the same archetype**, so the diversity pressure is cross-tenant.

Deterministic backstop: revive the dead `enforceVariety()` as `enforceDivergence(newFp, recentFps)` — compute an axis distance; if below threshold, rotate the *minimum* set of axes needed (flip palette mode, then pick the next hero pattern from the archetype's weighted list at index `regenCount`). The prompt asks; this guarantees. Brand colors and archetype persist unless the teacher asks otherwise, so a regeneration is a **redesign, not a rebrand** — coherent but meaningfully different.

---

## 12. Determinism

- `compileSite()` stays pure. Same `SiteDocument` + same `renderer.version` + same media rows → byte-identical HTML. Enforced by golden-file tests over fixture documents.
- All non-determinism (`randomUUID`, AI) happens at generation time and is frozen into the document.
- `renderer.version` in the document; `recompilePublished()` takes an explicit target version. Upgrading live sites becomes a deliberate, audited operation instead of a deploy side effect (this is exactly the class of bug the comment at `academy-site.service.ts:299` describes).
- Preview and publish share `SiteRenderService.compile()`, so they cannot diverge.

---

## 13. Quality gates

`QualityGateService` grows from 4 structural checks into a scored gate. **Errors block publish; warnings surface in the Studio** (today they are computed and discarded).

- **Accessibility** — body/heading/button contrast against the *actual* section surface; `alt` on content images; single `h1`; heading order; focus-visible; reduced-motion path present; `lang`/`dir` correct in both languages.
- **Responsive** — every pattern declares a mobile behavior; no base grid >2 columns; fixture render checked at 360/768/1280.
- **Composition** — no empty rendered section (fixes the counter-gap bug); every section's content requirement met; ≤2 consecutive identical surfaces; 5–12 sections.
- **Complexity** — node/section/effect budgets; inline CSS ≤ ~60KB; inline JS ≤ ~20KB.
- **Motion** — effect count, no conflicting combinations, reduced-motion always wins.
- **Performance** — lazy images except the hero; ≤2 webfont families requested (today 3 are always loaded regardless of the design).
- **Security** — an assertion that no AI-authored string occupies an attribute position, and no URL originates from AI.
- **Typography/contrast** — the semantic rules from §6 re-run as a pre-publish lint.

---

## 14. Testing strategy

**Phase 0 (before any refactor):**
- Golden HTML fixtures: 7 DNAs × 3 archetypes × {cover / no cover} — byte-compared. This is what makes the renderer split provably behavior-preserving.
- Unit tests for `SiteBrainService.arrange/assignVariants`, `DesignRulesService`, `EvolutionService`, `QualityGateService`, `assemble()`.

**Ongoing:**
- **Schema tests** — every enum value round-trips; unknown values degrade rather than throw; legacy v2 documents still parse.
- **Semantic validation tests** — a table of hostile/degenerate `DesignSpec`s (ink==background, 12 scroll effects, monumental+upper+condensed, unknown pattern id) each asserting the *repaired* output, not an exception.
- **Capability tests** — unknown pattern/component/effect ids resolve to a supported default with a verdict.
- **Content-fit tests** — `gallery.immersive` with 2 images downgrades; `courses.bento` with 1 course downgrades.
- **Renderer tests** — each pattern renders valid HTML for empty/minimal/maximal content; CSS/JS modules emitted only when used.
- **Snapshot tests** — golden HTML per fixture document; a diff is a deliberate act, not an accident.
- **Security tests** — inject `<script>`, `javascript:`, `" onload=`, RTL-override chars into every AI-controlled field of a fixture plan; assert none appear unescaped and none reach an attribute.
- **AI output fixture tests** — recorded real PLAN responses (good, mediocre, malformed, adversarial) replayed through validation → composition, with no network.
- **Archetype fixtures** — one representative teacher per archetype, end-to-end from facts to HTML, asserting *distinctness* (fingerprints of any two must differ on ≥3 axes).
- **Determinism test** — compile the same document twice, assert identical bytes.
- **Responsive test** — static assertion over emitted CSS that every grid has a ≤2-column base rule.

---

## 15. Migration phases

| Phase | Scope | Risk | Visible change |
|---|---|---|---|
| **0. Safety net** | Golden fixtures + unit tests for brain/rules/evolution/quality/assemble | none | none |
| **1. Renderer decomposition** | Split `site-compiler.ts` into token/base/pattern/effect modules; on-demand emission; `ComponentRegistry`; move variants → patterns intact | low (golden tests prove parity) | smaller pages |
| **2. DesignSpec v3** | Extend `design` additively; compiler consumes new fields; `DesignRulesService` gains real contrast/coherence validation + **repair**; PLAN schema extended | low | richer, and the illegible-palette bug is fixed |
| **3. Pattern library** | 12 → ~40 patterns + new block types; selection still deterministic (`selectVariant`) — **AI not yet involved** | low | large visible variety win, zero new AI risk |
| **4. AI composes sections** | PLAN emits `sections[]`; `assemble()` materializes it; COPY becomes slot-driven; `stats`/timeline/matrix start carrying content | medium | genuinely different page structures |
| **5. Tier-2 composition** | Node renderers, bounded trees, responsive `at` map, hero + ≤2 feature sections | medium | bespoke heroes |
| **6. ContentProfile v2** | Course/review/media queries; capability brief in prompt; content-fit gate | low | content-appropriate layouts |
| **7. Evolution fingerprints** | `fingerprint`/`rationale` columns; cross-archetype diversity signal; `enforceDivergence` | low | regeneration genuinely differs |
| **8. Quality gate v2 + Studio UI** | Scored gate; warnings surfaced; per-section "try another layout" (deterministic, **no AI cost**) | low | teacher control |
| **9. Document upgrade** | `scripts/upgrade-site-docs.ts`: stamp `renderer.version`, optionally re-run deterministic pattern selection on old docs | low | old sites get new layouts without an AI call |

Phase 3 is deliberately placed before Phase 4: it delivers most of the visible "not a template" win using only deterministic selection, which de-risks everything after it. If Phase 4 or 5 disappoints, the product is still far ahead of today.

No destructive data migration at any point — every schema field is optional and additive, and `liftLegacyDesign()` handles the v2→v3 shape in code rather than in the database.

---

## 16. Risks and tradeoffs

| Risk | Mitigation |
|---|---|
| More freedom → worse average design | Two-tier model; patterns are hand-built and always the fallback; archetype weights; repair-not-reject; Phase 3 before Phase 4 |
| PLAN response truncation (`maxTokens: 1500` today) | Raise to ~6000, `effort: 'medium'`; the truncation path already throws RETRYABLE (`ai.client.ts:99`) |
| Cost roughly doubles per generation | Still cents; `assertWithinBudget()` already gates; per-section re-layout in Phase 8 costs nothing |
| Combinatorial explosion of CSS to maintain | On-demand modules keep each pattern's CSS local and independently testable |
| Pattern/CSS conflicts across combinations | Pattern CSS is namespaced under its pattern class; a matrix test renders every pattern under every `surface` |
| `brandTokens` contract with the React console | `AcademyProvider.tsx` reads 4 fields — keep those exact keys in `DesignSpec.palette`; add a lift function rather than changing the contract |
| Published pages are frozen HTML | `renderer.version` + explicit `recompilePublished(target)` makes upgrades intentional and reversible |
| Teacher regenerates and loses a design they liked | Snapshots already exist; surface the fingerprint + rationale in the version list so "the dark editorial one" is findable |

---

## 17. Files likely to change

**Heavy change**
- `renderer/site-compiler.ts` → split into `renderer/css/*`, `renderer/js/*`, `renderer/patterns/*`, `renderer/nodes/*`, `renderer/components/*`
- `generation/site-generator.service.ts` — extract step gains live signals; `assemble()` becomes composition-driven
- `pipeline/design-rules.service.ts` — from 2 rules to the semantic/repair engine
- `pipeline/site-brain.service.ts` — from arrange+assign to full composition resolution
- `generation/planning.schema.ts` + `planning.jsonschema.ts` — the new `SiteComposition`
- `generation/plan-prompt.ts` — capability brief, pattern catalogue, fingerprint history
- `schema/site-document.ts` — `DesignSpec`, `SectionSpec`, new block types, `renderer.version`

**Moderate**
- `renderer/variants/registry.ts` → `PatternRegistry` (additive)
- `renderer/variants/defaults.ts` → `renderer/patterns/legacy/*` (moved intact)
- `pipeline/evolution.service.ts` — fingerprints, `enforceDivergence`
- `pipeline/quality-gate.service.ts` — scored gate
- `pipeline/contracts.ts` — `RenderPlan` carries the resolved composition
- `generation/ai-copy.schema.ts` / `.jsonschema.ts` — slot-driven
- `generation/regen.ts` — per-section regen must respect the section's pattern
- `prisma/schema.prisma` — two nullable columns on `AcademySiteSnapshot`

**Light**
- `renderer/site-render.service.ts`, `site/academy-site.service.ts` (recompile target version)
- `apps/web/src/pages/academy/studio/{EditorTab,PublishTab,GenerateTab}.tsx` — verdicts, rationale, per-section layout swap
- `apps/web/src/components/AcademyProvider.tsx` — keep the 4-token contract

**New**
- `pipeline/capability-registry.ts`, `pipeline/content-profile.ts`, `pipeline/content-fit.rules.ts`, `pipeline/composition-budget.ts`, `pipeline/fingerprint.ts`, `pipeline/archetype-profiles.ts`
- `schema/composition.schema.ts`
- `renderer/patterns/**`, `renderer/nodes/**`, `renderer/components/**`
- tests: `__fixtures__/**`, `*.spec.ts` across pipeline and renderer

---

## 18. Recommended implementation order

1. **Phase 0** — tests and golden fixtures. Non-negotiable first step; everything after it is otherwise a blind refactor of a live system.
2. **Phase 1** — renderer decomposition, parity-proven.
3. **Phase 2** — DesignSpec v3 + real design-rule validation (also ships a genuine bug fix: nothing currently checks the AI's text/background contrast).
4. **Phase 3** — the pattern library. Biggest visible win per unit of risk.
5. **Phase 6** — ContentProfile v2 (small, and Phase 4 needs it to be good).
6. **Phase 4** — AI composes the section list.
7. **Phase 7** — evolution fingerprints.
8. **Phase 5** — Tier-2 composition trees.
9. **Phase 8** — quality gate v2 + Studio UI.
10. **Phase 9** — document upgrade script.

---

## 19. Worked examples

### A. Programming teacher — "systems, not slides"

```jsonc
{
  "archetype": "programming",
  "designSpec": {
    "palette": { "mode":"dark", "background":"#080A0F", "ink":"#E8EDF7", "surface":"#0F131C",
                 "surfaceAlt":"#141A26", "primary":"#3DDC97", "accent":"#5B8CFF" },
    "typography": { "headingFamily":"condensed", "bodyFamily":"mono", "scale":"monumental",
                    "headingWeight":800, "headingCase":"upper", "tracking":"tight", "measure":"narrow" },
    "geometry": { "radius":2, "radiusStyle":"uniform", "border":"hairline", "shadow":"none", "grain":true },
    "rhythm": { "density":"compact", "sectionRhythm":"alternating", "containerWidth":"wide", "gutter":"tight" },
    "motion": { "intensity":"lively", "entrance":"mask-reveal", "scrollFx":["sticky-headings","counters"] },
    "decoration": { "background":"grid-lines", "accents":["corner-brackets","rule-lines"],
                    "dividers":"notch", "imageTreatment":"grid-overlay" }
  },
  "sections": [
    { "type":"hero", "pattern":"hero.bento-hero", "emphasis":"feature", "width":"wide", "surface":"page",
      "composition": { "kind":"Bento", "columns":3, "gap":"sm", "children":[
        { "kind":"Stack", "span":2, "gap":"md", "children":[
          { "kind":"Eyebrow", "bind":{"field":"hero.eyebrow"} },
          { "kind":"Heading", "level":1, "bind":{"field":"hero.headline"}, "treatment":"outline" },
          { "kind":"Text", "bind":{"field":"hero.subheadline"}, "size":"lead" },
          { "kind":"Row", "gap":"sm", "children":[
            { "kind":"EnrollButton", "role":"primary" },
            { "kind":"Button", "bind":{"field":"hero.secondaryLabel"}, "role":"ghost" } ] } ] },
        { "kind":"Stack", "span":1, "surface":"raised", "padding":"md", "children":[
          { "kind":"Stat", "index":0 }, { "kind":"Divider" }, { "kind":"Stat", "index":1 } ] },
        { "kind":"Image", "span":3, "mediaId":"…", "treatment":"grid-overlay", "ratio":"16:9" } ],
        "at": { "md": { "columns":1 } } } },
    { "type":"toolkit",     "pattern":"toolkit.skill-matrix",   "surface":"raised",  "columns":4 },
    { "type":"courses",     "pattern":"courses.bento",          "emphasis":"feature","width":"wide" },
    { "type":"process",     "pattern":"process.numbered-rail",  "surface":"page" },
    { "type":"credentials", "pattern":"credentials.timeline",   "surface":"inverted" },
    { "type":"reviews",     "pattern":"reviews.quote-wall" },
    { "type":"faq",         "pattern":"faq.two-column",         "emphasis":"quiet" },
    { "type":"contact",     "pattern":"contact.split-cta",      "surface":"accent" }
  ]
}
```

### B. Mathematics teacher — "the whiteboard, cleaned up"

Light `#FBFBF8` paper, near-black ink, single blue accent · `serif` headings / `sans` body, `balanced` scale, `wide` measure · radius 4, hairline borders, no shadow · `airy`, `crescendo` rhythm, `narrow` container · `calm` motion, `fade` entrance, `progress-bar` only · `topography` background, `numbered-sections` accent, `hairline` dividers.
Sections: `hero.editorial-statement` (no image — typography-driven, because there is no cover) → `about.two-column-editorial` → `process.numbered-rail` → `stats.big-numbers` → `courses.featured-plus-list` → `faq.numbered` → `contact.pills`.

### C. Languages teacher — "warm, human, spoken"

Warm light `#FFF9F2`, terracotta primary, teal accent · `serif` headings, `sans` body, `dramatic` scale, `wide` tracking · radius 24, soft shadow, `mask-arch` imagery · `expansive` density, `standard` width · `cinematic` motion, `rise` entrance, `parallax` + `pointer-glow` · `aurora` background, `underline-swash` + `blob` accents.
Sections: `hero.offset-collage` (portrait + two gallery frames) → `about.portrait-quote` → `reviews.quote-wall` **early** (social proof leads for languages) → `toolkit.marquee-band` → `courses.carousel-rail` → `gallery.masonry` → `faq.accordion` → `contact.footer-band`.

### D. Exam-prep teacher — "results, loudly"

Saturated dark `#0B0714`, magenta primary, cyan accent · `display` headings, `sans` body, `monumental` scale, weight 900 · radius 14, `deep` shadow · `compact` density, `alternating` rhythm, `wide` container · `cinematic`, `stagger-grid`, `counters` + `progress-bar` · `mesh` background, `sticker-badges` accents.
Sections: `hero.image-full` (cover + scrim) → `metric-band` (results, counters) → `credentials.timeline` → `courses.grid` **with a featured card** → `reviews.cards` → `stats.inline-strip` → `faq.accordion` → `contact.split-cta`.

### E. University lecturer — "quiet authority"

Deep `#0E1116` with a bone `#EDEAE3` ink, restrained gold accent · `serif` headings, `serif` body, `restrained` scale, `normal` tracking, `wide` measure · radius 0, `strong` border, no shadow, grain on · `expansive` density, `even` rhythm, `narrow` container · `calm`, `fade`, `sticky-headings` only · `none` background, `rule-lines` accent, `hairline` dividers.
Sections: `hero.centered` (type only) → `credentials.numbered-list` → `about.statement` → `toolkit.icon-grid` → `courses.list` → `faq.two-column` → `contact.pills`.

**What these demonstrate:** A and E share *zero* pattern ids, opposite geometry, opposite density, different type systems and different section counts. Under today's model both would be an `editorial_dark`/`royal_night` page with a different `--rad` and a different `heroTreatment` — the same page in different paint.
