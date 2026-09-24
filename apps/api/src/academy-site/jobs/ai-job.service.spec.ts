import { AiJobService } from './ai-job.service';

/**
 * Stopping a job, and not bringing it back.
 *
 * A teacher's "stop" used to leave the job RUNNING, holding the academy's
 * lock until the call in flight returned; and a call that returned after a
 * stop wrote SUCCEEDED over it.
 */
describe('stopping an AI job', () => {
  const build = () => {
    const prisma = {
      aiJob: {
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        update: jest.fn(),
        findUnique: jest.fn(),
      },
    };
    const service = new AiJobService(prisma as never, { enabled: true } as never);
    return { prisma, service };
  };

  it('stops a job that is queued or already running', async () => {
    const { prisma, service } = build();
    await service.stop('acad1', 'job1');
    expect(prisma.aiJob.updateMany).toHaveBeenCalledWith({
      where: { id: 'job1', academyId: 'acad1', status: { in: ['QUEUED', 'RUNNING'] } },
      data: { status: 'CANCELED', leaseExpiresAt: null },
    });
  });

  it('never writes SUCCEEDED over a job that was stopped while it ran', async () => {
    const { prisma, service } = build();
    await service.succeed('job1', { costCents: 3 });
    expect(prisma.aiJob.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'job1', status: 'RUNNING' } }),
    );
    expect(prisma.aiJob.update).not.toHaveBeenCalled();
  });

  it('never fails or retries a job that was stopped', async () => {
    const { prisma, service } = build();
    prisma.aiJob.findUnique.mockResolvedValue({ id: 'job1', status: 'CANCELED', attempts: 1 });
    await service.fail('job1', { message: 'timeout', errorClass: 'RETRYABLE' });
    expect(prisma.aiJob.updateMany).not.toHaveBeenCalled();
    expect(prisma.aiJob.update).not.toHaveBeenCalled();
  });
});
