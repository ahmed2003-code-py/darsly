import { createContext, ReactNode, useContext } from 'react';
import { AcademyBranding, useAcademyBranding } from '../lib/academy';

interface AcademyCtx {
  branding?: AcademyBranding;
  isLoading: boolean;
  error: unknown;
}

const Ctx = createContext<AcademyCtx>({ isLoading: true, error: null });

/** Access the active academy's branding within a provider subtree. */
export const useAcademy = () => useContext(Ctx);

/**
 * Resolves an academy by slug and scopes its brand color to the subtree via the
 * `--academy-primary` CSS variable. Once inside, the UI reads the academy's
 * identity, not the platform's — the "private workspace" feel.
 */
export default function AcademyProvider({ slug, children }: { slug: string; children: ReactNode }) {
  const { data, isLoading, error } = useAcademyBranding(slug);
  const tokens = data?.brandTokens ?? undefined;

  // Every token the academy actually published becomes a CSS variable on this
  // subtree. Anything it did not publish is simply absent, so the platform's own
  // value keeps applying — an academy that never opened the Studio looks exactly
  // as it did before.
  const style: Record<string, string> = { '--academy-primary': data?.colorPrimary || '#4A32C9' };
  if (data?.colorAccent) style['--academy-accent'] = data.colorAccent;
  if (tokens?.background) style['--academy-bg'] = tokens.background;
  if (tokens?.ink) style['--academy-ink'] = tokens.ink;
  if (tokens?.surface) style['--academy-surface'] = tokens.surface;
  if (typeof tokens?.radius === 'number') style['--academy-radius'] = `${tokens.radius}px`;

  return (
    <Ctx.Provider value={{ branding: data, isLoading, error }}>
      <div style={style as never} className="min-h-screen">
        {children}
      </div>
    </Ctx.Provider>
  );
}
