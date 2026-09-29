import type { ReactNode } from 'react';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import ColorModeToggle from '../ColorModeToggle';

/**
 * The frame of every Live page someone reaches from a link — the public
 * session page, a guest's own page. Same tokens as the rest of Darsly, and
 * the same light/dark switch (these pages have no app shell to carry it).
 */
export default function LivePublicShell({
  children,
  back,
}: {
  children: ReactNode;
  back?: ReactNode;
}) {
  const { i18n } = useTranslation();
  return (
    <div className="min-h-screen bg-surface text-on-surface" dir={i18n.dir()}>
      <header className="mx-auto flex w-full max-w-2xl items-center justify-between px-4 pt-4">
        <div className="min-w-0">{back}</div>
        <p className="font-heading text-xl font-extrabold text-primary">درسلي</p>
        <ColorModeToggle />
      </header>
      <main className="mx-auto w-full max-w-2xl space-y-4 px-4 pb-12 pt-4">{children}</main>
    </div>
  );
}

/** A ticking "starts in 1:02:03", on the server's clock. */
export function useNow(active: boolean, skewMs = 0) {
  const [now, setNow] = useState(() => Date.now() + skewMs);
  useEffect(() => {
    if (!active) return;
    const i = setInterval(() => setNow(Date.now() + skewMs), 1000);
    return () => clearInterval(i);
  }, [active, skewMs]);
  return now;
}

/** How far this device's clock is from the server's (ms to add to Date.now()). */
export function skewFrom(serverNow: string | undefined, receivedAt: number) {
  const s = serverNow ? new Date(serverNow).getTime() : NaN;
  if (!Number.isFinite(s)) return 0;
  const d = s - receivedAt;
  return Math.abs(d) < 30_000 ? 0 : d;
}
