import { Logger } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';

/** The two things this needs from AiJobService (a narrow seam, and a fake in tests). */
export interface SummaryJobs {
  enqueue(
    academyId: string,
    type: 'LIVE_SUMMARY',
    input: Record<string, unknown>,
    opts: { sameInput: { path: string; equals: string } },
  ): Promise<unknown>;
  hasActiveJobFor(type: 'LIVE_SUMMARY', path: string, equals: string): Promise<boolean>;
}

const logger = new Logger('LiveSummaryQueue');

/**
 * Queue a lesson summary — at most one in flight per class.
 *
 * The class is claimed first (summaryStatus → PROCESSING, only from a state
 * that is not already PROCESSING), so two presses, or a press racing the
 * automatic trigger, queue one job. A job already queued or running for the
 * class is the answer to this call too: it reads the transcript's CURRENT
 * revision when it runs, and a summary made from older words is not written
 * (see LiveSummaryHandler). Speech-to-text is never re-run by anything here.
 *
 * `force` makes a new summary even when one exists for these words (the
 * teacher's "regenerate"). Returns what the class is doing now.
 */
export async function queueLiveSummary(
  prisma: PrismaService,
  jobs: SummaryJobs,
  sessionId: string,
  opts: { force?: boolean; reason: string },
): Promise<'PROCESSING' | 'NOT_QUEUED'> {
  const s = await prisma.liveSession.findUnique({
    where: { id: sessionId },
    select: { tenantId: true, academyId: true, summaryStatus: true, summaryError: true },
  });
  if (!s) return 'NOT_QUEUED';
  if (await jobs.hasActiveJobFor('LIVE_SUMMARY', 'liveSessionId', sessionId)) {
    await prisma.liveSession.updateMany({
      where: { id: sessionId, summaryStatus: { not: 'PROCESSING' } },
      data: { summaryStatus: 'PROCESSING', summaryError: null },
    });
    return 'PROCESSING';
  }
  const claimed = await prisma.liveSession.updateMany({
    where: { id: sessionId, summaryStatus: { not: 'PROCESSING' } },
    data: { summaryStatus: 'PROCESSING', summaryError: null },
  });
  if (claimed.count === 0) return 'PROCESSING';
  try {
    await jobs.enqueue(
      s.academyId ?? s.tenantId,
      'LIVE_SUMMARY',
      { liveSessionId: sessionId, ...(opts.force ? { force: true } : {}) },
      { sameInput: { path: 'liveSessionId', equals: sessionId } },
    );
    logger.log(`live.summary.queued liveSession=${sessionId} reason=${opts.reason} force=${!!opts.force}`);
    return 'PROCESSING';
  } catch (e) {
    // Not queued (AI switched off, month's budget spent, a job appeared a
    // moment ago): say so instead of leaving a spinner.
    const code = (e as { response?: { code?: string } })?.response?.code;
    if (code === 'AI_JOB_ACTIVE') return 'PROCESSING';
    await prisma.liveSession.updateMany({
      where: { id: sessionId, summaryStatus: 'PROCESSING' },
      data: { summaryStatus: 'FAILED', summaryError: 'ENQUEUE_FAILED' },
    });
    logger.warn(`live.summary.not-queued liveSession=${sessionId}: ${(e as Error).message}`);
    return 'NOT_QUEUED';
  }
}
