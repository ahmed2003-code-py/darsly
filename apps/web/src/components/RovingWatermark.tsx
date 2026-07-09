import { useEffect, useState } from 'react';
import type { WatermarkPayload } from '@darsly/shared-types';

/**
 * Always-on forensic overlay: student name + phone + watermark id + a LIVE
 * clock, repositioned every few seconds so it can't be cropped out of a
 * recording. A leaked clip's visible watermark id resolves back to the exact
 * student + session via the teacher's Leak-Trace tool. Semi-transparent so it
 * doesn't ruin viewing but is always legible on a capture.
 */
export default function RovingWatermark({ payload }: { payload: WatermarkPayload }) {
  const [pos, setPos] = useState({ top: 12, left: 12 });
  const [now, setNow] = useState(() => new Date());

  // Reposition every 4s to a random anchor within the frame.
  useEffect(() => {
    const move = () =>
      setPos({
        top: 8 + Math.random() * 78, // %
        left: 8 + Math.random() * 62,
      });
    move();
    const id = window.setInterval(move, 4000);
    return () => window.clearInterval(id);
  }, []);

  // Live timestamp so a still frame reveals capture time.
  useEffect(() => {
    const id = window.setInterval(() => setNow(new Date()), 1000);
    return () => window.clearInterval(id);
  }, []);

  const phoneTail = payload.studentPhone ? payload.studentPhone.slice(-4) : '----';

  return (
    <div className="pointer-events-none absolute inset-0 z-20 overflow-hidden select-none">
      <div
        className="absolute whitespace-nowrap font-mono text-[11px] leading-tight text-white/45 transition-all duration-1000"
        style={{
          top: `${pos.top}%`,
          insetInlineStart: `${pos.left}%`,
          textShadow: '0 1px 3px rgba(0,0,0,0.8)',
        }}
        dir="ltr"
      >
        <div className="font-bold">{payload.studentName} · ****{phoneTail}</div>
        <div>{payload.watermarkId}</div>
        <div>{now.toLocaleTimeString('en-GB')} · {now.toLocaleDateString('en-GB')}</div>
      </div>

      {/* Faint corner brand mark, static — a second anchor if the roving one is cropped. */}
      <div
        className="absolute bottom-2 end-3 font-mono text-[10px] text-white/25"
        dir="ltr"
      >
        {payload.watermarkId}
      </div>
    </div>
  );
}
