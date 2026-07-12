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
  const primary = data?.colorPrimary || '#4A32C9';
  return (
    <Ctx.Provider value={{ branding: data, isLoading, error }}>
      <div style={{ ['--academy-primary' as any]: primary }} className="min-h-screen">
        {children}
      </div>
    </Ctx.Provider>
  );
}
