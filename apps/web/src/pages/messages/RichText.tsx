import { useMemo } from 'react';
import { tokenizeLinks } from '../../lib/linkTokens';

/**
 * A message's text: line breaks kept, links clickable, nothing else
 * interpreted — no markdown, no HTML. Each piece becomes a React text node or
 * an <a>, so a message cannot inject markup.
 *
 * `dir="auto"` lets an English line inside an Arabic conversation (and the
 * reverse) take its own direction; long unbroken strings wrap anywhere rather
 * than widening the bubble.
 */
export default function RichText({ text, onColor }: { text: string; onColor?: boolean }) {
  const tokens = useMemo(() => tokenizeLinks(text), [text]);
  return (
    <p
      dir="auto"
      className="whitespace-pre-wrap text-[15px] leading-relaxed [overflow-wrap:anywhere]"
    >
      {tokens.map((t, i) =>
        t.type === 'link' ? (
          <a
            key={i}
            href={t.href}
            target="_blank"
            rel="noopener noreferrer nofollow"
            dir="ltr"
            className={`underline underline-offset-2 hover:no-underline ${
              onColor ? 'text-on-primary decoration-on-primary/60' : 'text-primary-text'
            }`}
          >
            {t.value}
          </a>
        ) : (
          <span key={i}>{t.value}</span>
        ),
      )}
    </p>
  );
}
