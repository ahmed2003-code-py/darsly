/** Shared renderer types. Kept separate so variants, shared helpers and the
 *  compiler can import them without cycles. */

export interface RenderMedia {
  url: string;
  blurhash?: string | null;
  width?: number | null;
  height?: number | null;
}

export interface RenderContext {
  academyName: string;
  slug: string;
  defaultLang: 'ar' | 'en';
  /** Resolve a media id to its public URL + metadata (READY media only). */
  media: (id: string) => RenderMedia | undefined;
}

/**
 * What a section variant actually receives: the caller's context plus the things
 * only the compiler can work out by looking at the whole page.
 */
export interface VariantContext extends RenderContext {
  /**
   * Where a call-to-action should send a visitor.
   *
   * The compiler resolves this because only it can see every block: if the page
   * has a courses section the CTA scrolls to it, and if it does not the CTA has
   * to leave the page rather than be a dead anchor. Variants must never invent
   * their own destination — that is exactly how "ابدأ الآن" came to point at
   * `#courses-<hero-block-id>`, an element that never existed on the page.
   */
  ctaHref: string;
}

/** Bilingual text. `en` may be empty when only Arabic was produced. */
export type LT = { ar: string; en: string };
