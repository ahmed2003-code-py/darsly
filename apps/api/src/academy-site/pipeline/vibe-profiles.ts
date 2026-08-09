/**
 * The four directions a teacher can actually choose.
 *
 * The vibe used to reach the designer as a single word — "PREFERRED VIBE:
 * premium" — and then did nothing, because one adjective is not a brief. The
 * archetype guidance underneath it was far more specific, so in practice the
 * subject decided the design and the teacher's own choice was decoration.
 *
 * Each vibe is now a complete direction: what it is trying to feel like, where
 * its palette sits, how its type behaves, how much it moves, and — as important
 * — how it fails. They are written to be genuinely far apart. Two of these
 * applied to the same teacher should not produce pages anyone would call
 * similar.
 *
 * Precedence, stated here and in the prompt, is: a written style brief beats the
 * vibe, the vibe beats the subject guidance, and the subject guidance beats the
 * platform's defaults. The teacher's explicit choice is not a hint.
 */

export const VIBE_KEYS = ['trusted', 'academic', 'premium', 'energetic'] as const;
export type VibeKey = (typeof VIBE_KEYS)[number];

export interface VibeProfile {
  /** What this direction is for, in the teacher's terms. */
  label: string;
  /** The feeling in one line — the sentence the whole design has to serve. */
  mood: string;
  /** Where the palette should sit. Reference colours, not a fixed palette. */
  palette: string;
  typography: string;
  geometry: string;
  rhythm: string;
  motion: string;
  decoration: string;
  /** Patterns that carry this direction well. */
  favours: string[];
  /** The specific ways this direction goes wrong. */
  avoid: string;
}

export const VIBE_PROFILES: Record<VibeKey, VibeProfile> = {
  trusted: {
    label: 'Warm & trusted',
    mood:
      'A person, not an institution. A parent choosing for their child should feel they have met someone patient and competent. Warmth is the whole brief — everything else serves it.',
    palette:
      'Light and warm. Off-white or cream paper (#FDFAF5, #FFF9F0, #F8F5EE), never pure white, and never a cold grey. Ink is a soft near-black with warmth in it (#241C16, #2A2320). One earthy primary — terracotta, clay, olive, deep teal (#C2592F, #B4552E, #4F7A5E, #0F766E) — with a quiet complement. Saturated neon of any kind breaks this instantly.',
    typography:
      'A friendly serif or a humanist sans for headings; sans for body. Scale balanced or dramatic, weight 600–700, normal case, normal or wide tracking, wide measure. Nothing condensed, nothing shouted.',
    geometry: 'Round: radius 18–30. Hairline or no borders. Soft shadow. No grain.',
    rhythm: 'Airy or expansive, standard container, generous gutters. This design breathes.',
    motion: 'Lively or cinematic with a rise entrance. Movement here is gentle, not energetic.',
    decoration:
      'gradient-wash or aurora, or none at all. Accents: underline-swash, blob, rule-lines. Hairline dividers. Images rounded, mask-arch or ring — a portrait should feel welcoming.',
    favours: [
      'hero.split-portrait', 'hero.offset-collage', 'about.side-by-side', 'about.statement',
      'reviews.wall', 'process.numbered', 'courses.grid', 'faq.accordion', 'contact.pills',
    ],
    avoid:
      'Dark backgrounds, condensed or uppercase headings, sharp corners, grid or blueprint backdrops. Any of these turns "someone I trust with my child" into "a company".',
  },

  academic: {
    label: 'Academic',
    mood:
      'Ordered and unhurried, like a well-set textbook. Nothing is sold loudly because the structure is the argument. A student should be able to see the whole syllabus at a glance.',
    palette:
      'Light, cool and clean, or a restrained dark. Paper white to bone (#FFFFFF, #FBFBF9, #F6F7F9) with a near-black ink that has a blue cast (#0E1520, #131820). One serious primary — ink blue, forest, oxblood (#1D4ED8, #16457C, #14532D, #7F1D1D). At most one accent, used sparingly.',
    typography:
      'Serif headings, serif or sans body. Scale restrained or balanced — the type is not the event. Weight 500–700, normal case, normal tracking, wide measure so paragraphs read like prose.',
    geometry: 'Sharp: radius 0–6. Hairline or strong borders — structure comes from rules, not shadows. No shadow. No grain.',
    rhythm: 'Airy or expansive, narrow or standard container. Even rhythm; a syllabus does not crescendo.',
    motion: 'Calm, with a fade entrance. At most one scroll effect, and sticky-headings is the one that fits.',
    decoration:
      'none or topography. Accents: rule-lines, numbered-sections. Hairline dividers. Images plain or ring — no duotone, no tilt.',
    favours: [
      'hero.editorial', 'hero.centered', 'about.two-column', 'process.numbered',
      'credentials.record', 'timeline.rail', 'courses.list', 'stats.band', 'faq.plain', 'faq.two-column',
    ],
    avoid:
      'Gradients as decoration, marquees, parallax, big rounded cards, display or condensed faces. Anything that looks like it is trying to sell undermines the one thing this direction has.',
  },

  premium: {
    label: 'Premium',
    mood:
      'Expensive restraint. Space is the luxury: fewer things, larger, further apart. It should feel like it costs more because it is worth more, never because it is louder.',
    palette:
      'Deep and dark, or a very quiet bone light. Near-black with a hue in it — ink, aubergine, forest (#0B0B10, #0E1116, #100D14, #0C1210) — with a bone or warm-grey text (#EDEAE3, #E8E6E1). One metallic or jewel primary: champagne, brass, deep gold, oxidised green (#C8A96A, #B08D57, #D4AF37, #2F6F5E). The accent may equal the primary; a single colour used well is the point.',
    typography:
      'Serif headings — this is the direction serifs exist for. Serif or sans body. Scale dramatic or restrained, never in between. Weight 400–700, normal case, normal tracking, wide measure.',
    geometry: 'Radius 0–8. Hairline borders. No shadow or deep shadow, nothing in between. Grain on, if the page is dark — it is what makes a flat dark page look printed rather than empty.',
    rhythm: 'Expansive, narrow or standard container. Even or crescendo. Whitespace is the product.',
    motion: 'Calm or cinematic with a fade or mask-reveal entrance. One scroll effect at most. Slow beats busy.',
    decoration:
      'none, orbits, or a barely-there spotlight. Accents: rule-lines, corner-brackets. Hairline dividers. Images plain, ring or duotone.',
    favours: [
      'hero.editorial', 'hero.image-full', 'about.statement', 'quote.statement',
      'credentials.record', 'timeline.rail', 'gallery.immersive', 'reviews.spotlight',
    ],
    avoid:
      'Bright saturated colour, more than two typefaces in play, bento grids, sticker badges, marquees, counters. Premium fails by adding, never by subtracting.',
  },

  energetic: {
    label: 'Energetic',
    mood:
      'Momentum. Built for a student with an exam in eleven weeks who needs to believe this will work. Results early, proof loud, and the page never stops moving forward.',
    palette:
      'Saturated and high-contrast, usually dark. Near-black with a colour cast (#08080F, #0B0714, #0A0F1E) and a bright ink (#FFFFFF, #F2F5FF). A vivid primary and a genuinely different accent — magenta/cyan, lime/violet, orange/blue (#FB3B6C + #22D3EE, #A3E635 + #7C3AED, #F97316 + #3B82F6). A light version works too, but the colour must still be loud.',
    typography:
      'Display or condensed headings, weight 800–900. Scale dramatic or monumental. Uppercase is allowed here and nowhere else. Tight tracking, narrow or normal measure. Sans body — never serif.',
    geometry: 'Radius 10–20, or 0 for a harder edge. Hairline or strong borders. Deep or brutal shadow. Grain only if dark.',
    rhythm: 'Compact or regular, wide container, alternating bands. Density is part of the urgency.',
    motion: 'Cinematic or lively. stagger-grid or slide entrance. Use the effects: counters on figures, a progress bar, a marquee.',
    decoration:
      'mesh, spotlight or aurora. Accents: sticker-badges, corner-brackets. Notch or gradient dividers. Images grid-overlay, duotone or tilt.',
    favours: [
      'hero.image-full', 'hero.bento', 'stats.big-numbers', 'timeline.columns', 'credentials.wall',
      'courses.bento', 'reviews.wall', 'toolkit.marquee', 'contact.split-cta',
    ],
    avoid:
      'Serif headings, expansive whitespace, calm motion, a palette that could be described as tasteful. Restraint is the failure mode here — a quiet energetic page is just a worse warm one.',
  },
};

const isVibe = (v: string): v is VibeKey => (VIBE_KEYS as readonly string[]).includes(v);

export function vibeProfile(vibe: string | undefined): VibeProfile {
  return VIBE_PROFILES[vibe && isVibe(vibe) ? vibe : 'trusted'];
}

/** The chosen direction, written out for the planning model. */
export function vibeBrief(vibe: string | undefined): string {
  const v = vibeProfile(vibe);
  return [
    `  DIRECTION: ${v.label}`,
    `  mood: ${v.mood}`,
    `  palette: ${v.palette}`,
    `  typography: ${v.typography}`,
    `  geometry: ${v.geometry}`,
    `  rhythm: ${v.rhythm}`,
    `  motion: ${v.motion}`,
    `  decoration: ${v.decoration}`,
    `  patterns that carry it: ${v.favours.join(', ')}`,
    `  how this direction fails: ${v.avoid}`,
  ].join('\n');
}
