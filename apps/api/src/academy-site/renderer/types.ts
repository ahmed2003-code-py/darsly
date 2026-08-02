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

/** Bilingual text. `en` may be empty when only Arabic was produced. */
export type LT = { ar: string; en: string };
