import { Archetype } from '../generation/planning.schema';

/**
 * Subject-aware design, without templates.
 *
 * The temptation with archetypes is to map each one to a layout, at which point
 * every programming teacher gets the same page and the whole exercise has failed
 * again — just with six templates instead of five.
 *
 * So an archetype is a *vocabulary and a set of leanings*, never a filter. It
 * changes which patterns the planning brief mentions first and how ties break
 * when the platform has to choose on its own. Nothing here forbids anything: a
 * languages teacher can absolutely have a blueprint backdrop if the model has a
 * reason, it just will not be suggested one.
 */

export interface ArchetypeProfile {
  /** How the subject tends to want to feel, in one line for the brief. */
  mood: string;
  /** Backdrops worth reaching for first. */
  backdrops: string[];
  /** Typefaces that suit the subject. */
  typefaces: string[];
  /** Which sections make this teacher's case, strongest first. */
  leadWith: string[];
  /** Patterns to mention first. */
  favours: string[];
  /** Available, but never suggested — it would read as costume. */
  discouraged: string[];
}

export const ARCHETYPE_PROFILES: Record<Archetype, ArchetypeProfile> = {
  programming: {
    mood: 'Precise and built. Reads like a tool, not a brochure. Dark and technical works well; so does stark and light.',
    backdrops: ['grid-lines', 'dot-matrix', 'blueprint'],
    typefaces: ['mono body', 'condensed headings', 'sharp radius (0–6)'],
    leadWith: ['courses', 'toolkit', 'process'],
    favours: ['hero.bento', 'toolkit.skill-matrix', 'courses.bento', 'process.rail', 'faq.two-column'],
    discouraged: ['gallery.immersive'],
  },
  math_science: {
    mood: 'Ordered and unhurried. The page should feel like a well-set textbook: clear hierarchy, generous margins, nothing shouting.',
    backdrops: ['topography', 'none', 'grid-lines'],
    typefaces: ['serif headings', 'wide measure', 'restrained or balanced scale'],
    leadWith: ['credentials', 'process', 'toolkit'],
    favours: ['hero.editorial', 'about.two-column', 'process.numbered', 'stats.band', 'faq.plain'],
    discouraged: ['toolkit.marquee'],
  },
  languages: {
    mood: 'Warm and human. Voices and faces matter more than diagrams; social proof belongs early.',
    backdrops: ['aurora', 'gradient-wash', 'orbits'],
    typefaces: ['serif or display headings', 'wide tracking', 'round radius (18–30)'],
    leadWith: ['about', 'reviews', 'gallery'],
    favours: ['hero.offset-collage', 'about.statement', 'reviews.wall', 'gallery.masonry', 'courses.rail', 'toolkit.marquee'],
    discouraged: ['toolkit.skill-matrix'],
  },
  exam_prep: {
    mood: 'Urgent and results-first. Numbers early, proof loud, momentum throughout.',
    backdrops: ['mesh', 'spotlight', 'aurora'],
    typefaces: ['display or condensed headings', 'heavy weight', 'dramatic or monumental scale'],
    leadWith: ['stats', 'credentials', 'reviews'],
    favours: ['hero.image-full', 'stats.big-numbers', 'timeline.columns', 'credentials.wall', 'contact.split-cta'],
    discouraged: ['about.two-column'],
  },
  university: {
    mood: 'Quiet authority. Nothing needs to be sold loudly; the credentials do the work.',
    backdrops: ['none', 'topography'],
    typefaces: ['serif headings and body', 'restrained scale', 'radius 0–4', 'strong borders'],
    leadWith: ['credentials', 'about', 'timeline'],
    favours: ['hero.centered', 'hero.editorial', 'credentials.record', 'timeline.rail', 'courses.list', 'faq.two-column'],
    discouraged: ['stats.big-numbers', 'toolkit.marquee'],
  },
  general: {
    mood: 'Clear and welcoming. Lead with the method and what the student walks away with.',
    backdrops: ['gradient-wash', 'spotlight', 'none'],
    typefaces: ['sans or serif headings', 'balanced scale'],
    leadWith: ['about', 'courses', 'credentials'],
    favours: ['hero.centered', 'hero.split-portrait', 'about.side-by-side', 'courses.grid'],
    discouraged: [],
  },
};

const isArchetype = (a: string): a is Archetype => a in ARCHETYPE_PROFILES;

export function archetypeProfile(archetype: string): ArchetypeProfile {
  return ARCHETYPE_PROFILES[isArchetype(archetype) ? archetype : 'general'];
}

/** The subject guidance handed to the planning model. */
export function archetypeBrief(archetype: string): string {
  const p = archetypeProfile(archetype);
  return [
    `  mood: ${p.mood}`,
    `  backdrops that suit it: ${p.backdrops.join(', ')}`,
    `  typographic leanings: ${p.typefaces.join('; ')}`,
    `  sections that make this teacher's case: ${p.leadWith.join(' → ')}`,
    `  patterns worth considering first: ${p.favours.join(', ')}`,
    p.discouraged.length ? `  available but rarely right here: ${p.discouraged.join(', ')}` : '',
    '  None of this is a rule. A teacher whose brief points elsewhere goes elsewhere.',
  ].filter(Boolean).join('\n');
}

/** A guess at the archetype from the raw facts, used before the model answers. */
export function guessArchetype(subjects: string[], stages: string[], bio: string): Archetype {
  const hay = [...subjects, ...stages, bio].join(' ').toLowerCase();
  const has = (...needles: string[]) => needles.some((n) => hay.includes(n));
  if (has('برمج', 'programming', 'python', 'javascript', 'code', 'كمبيوتر', 'software', 'حاسوب')) return 'programming';
  if (has('لغة', 'انجليزي', 'إنجليزي', 'french', 'english', 'فرنسي', 'ألماني', 'ielts', 'toefl', 'محادثة')) return 'languages';
  if (has('ثانوية عامة', 'امتحان', 'exam', 'revision', 'مراجعة', 'تنسيق')) return 'exam_prep';
  if (has('جامع', 'university', 'دكتور', 'phd', 'بحث', 'research')) return 'university';
  if (has('رياضيات', 'math', 'فيزياء', 'physics', 'كيمياء', 'chemistry', 'علوم', 'science', 'أحياء')) return 'math_science';
  return 'general';
}
