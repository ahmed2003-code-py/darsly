import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { AiJobError } from '../academy-site/ai/ai-job.error';
import { AiClient } from '../academy-site/ai/ai.client';
import { NotificationsService } from '../notifications/notifications.service';
import { PrismaService } from '../prisma/prisma.service';
import { DailyService } from './daily.service';
import { LiveService } from './live.service';
import { LiveSummaryHandler } from './live-summary.handler';

/**
 * The classroom's memory: who may read it, and what it is allowed to say.
 *
 * Two different kinds of rule live here. The chat and the recording are about
 * *access* — a class is a room, and what is said in it belongs to the people
 * who were admitted. The summary is about *truth*: it is generated from a
 * transcript and read by students revising for an exam, so the tests that
 * matter most are the ones that stop it inventing a lesson nobody taught.
 */

function world(over: {
  session?: any;
  booked?: boolean;
  staff?: boolean;
  teacherUserId?: string;
  remoteRecording?: string;
} = {}) {
  const session = {
    id: 'ls1',
    tenantId: 't1',
    title: 'الجبر',
    startsAt: new Date(Date.now() - 3600_000),
    durationMin: 60,
    status: 'ENDED',
    deletedAt: null,
    roomName: 'darsly-ls1',
    recordingId: null,
    recordingStatus: 'NOT_STARTED',
    summaryStatus: 'NOT_STARTED',
    summary: null,
    summaryForStudents: false,
    transcriptStatus: 'NOT_STARTED',
    transcriptText: null,
    teacher: { userId: over.teacherUserId ?? 'u_teacher' },
    ...over.session,
  };
  const created: any[] = [];
  const updated: any[] = [];
  const prisma = {
    liveSession: {
      findUnique: jest.fn(async () => ({ ...session })),
      findUniqueOrThrow: jest.fn(async () => ({ ...session })),
      findFirst: jest.fn(async ({ where }: any) =>
        where.tenantId && where.tenantId !== session.tenantId ? null : { ...session },
      ),
      update: jest.fn(async ({ data }: any) => {
        Object.assign(session, data);
        updated.push(data);
        return { ...session };
      }),
    },
    academyMembership: { findFirst: jest.fn(async () => (over.staff ? { id: 'm1' } : null)) },
    studentProfile: { findUnique: jest.fn(async () => ({ id: 'st_1', user: { fullName: 'طالب' } })) },
    liveBooking: {
      findUnique: jest.fn(async () => (over.booked ? { id: 'b1' } : null)),
      findMany: jest.fn(async () => [{ student: { userId: 'su_1' } }]),
    },
    liveChatMessage: {
      findMany: jest.fn(async () => []),
      create: jest.fn(async ({ data }: any) => {
        created.push(data);
        return {
          id: 'm1',
          body: data.body,
          createdAt: new Date(),
          user: { id: data.userId, fullName: 'طالب', role: 'STUDENT' },
        };
      }),
    },
    user: { findUnique: jest.fn(async () => ({ fullName: 'أ. أحمد' })) },
  } as unknown as PrismaService;

  const daily = {
    recordingLink: jest.fn(async () => ({ url: 'https://dl/x', expiresAt: new Date() })),
    // What the provider says about a recording that has not finished yet,
    // unless a test needs it to have finished.
    recording: jest.fn(async () => ({ status: over.remoteRecording ?? 'in-progress' })),
    transcriptFor: jest.fn(async () => null),
  } as unknown as DailyService;
  const realtime = { emitToLive: jest.fn() } as any;
  const jobs = { enqueue: jest.fn(async () => ({ id: 'j1' })) } as any;
  const notifications = { create: jest.fn(async () => ({})) } as unknown as NotificationsService;
  const service = new LiveService(prisma, notifications, {} as any, daily, realtime, jobs);
  return { service, prisma, daily, realtime, jobs, notifications, session, created, updated };
}

describe('the classroom chat belongs to the people in the room', () => {
  it('lets a booked student read and write', async () => {
    const { service, realtime } = world({ booked: true });
    const msg = await service.sendChat('u_student', 'ls1', '  السلام عليكم  ');
    expect(msg.body).toBe('السلام عليكم');
    // Delivered on the app's existing socket, into this session's room only.
    expect(realtime.emitToLive).toHaveBeenCalledWith('ls1', 'live:message', expect.any(Object));
  });

  it('refuses someone who never booked', async () => {
    const { service } = world({ booked: false });
    await expect(service.sendChat('u_stranger', 'ls1', 'hi')).rejects.toThrow(ForbiddenException);
    await expect(service.chatHistory('u_stranger', 'ls1')).rejects.toThrow(ForbiddenException);
  });

  it('lets the teacher in without a booking', async () => {
    const { service } = world({ booked: false, teacherUserId: 'u_teacher' });
    await expect(service.chatHistory('u_teacher', 'ls1')).resolves.toEqual([]);
  });

  it('lets an academy staff member in, and nobody else from another academy', async () => {
    const staffed = world({ booked: false, staff: true });
    await expect(staffed.service.chatHistory('u_assistant', 'ls1')).resolves.toEqual([]);
    const outsider = world({ booked: false, staff: false });
    await expect(outsider.service.chatHistory('u_other_tenant', 'ls1')).rejects.toThrow(ForbiddenException);
  });

  it('refuses an empty message rather than storing one', async () => {
    const { service } = world({ booked: true });
    await expect(service.sendChat('u_student', 'ls1', '   ')).rejects.toThrow(BadRequestException);
  });
});

describe('the recording is not a public link', () => {
  it('refuses while it is still processing', async () => {
    const { service } = world({ booked: true, session: { recordingStatus: 'PROCESSING', recordingId: 'r1' } });
    const err = await service.recordingLink('u_student', 'ls1').catch((e) => e);
    expect(err.getResponse()).toMatchObject({ code: 'RECORDING_NOT_READY' });
  });

  it('hides a ready recording from students until the teacher shares the lesson', async () => {
    const { service } = world({
      booked: true,
      session: { recordingStatus: 'READY', recordingId: 'r1', summaryForStudents: false },
    });
    const err = await service.recordingLink('u_student', 'ls1').catch((e) => e);
    expect(err.getResponse()).toMatchObject({ code: 'RECORDING_NOT_SHARED' });
  });

  it('catches a finished recording up with the provider, without a webhook', async () => {
    // Nothing tells us when processing ends, so the question is asked the
    // moment someone opens the page that would show the recording.
    const { service, session } = world({
      teacherUserId: 'u_teacher',
      session: { recordingStatus: 'PROCESSING', recordingId: 'r1' },
      remoteRecording: 'finished',
    });
    const d = await service.sessionDetail('u_teacher', 'ls1');
    expect(d.recording.status).toBe('READY');
    expect(d.recording.available).toBe(true);
    expect(session.recordingStatus).toBe('READY');
  });

  it('leaves it processing while the provider is still working', async () => {
    const { service, session } = world({
      teacherUserId: 'u_teacher',
      session: { recordingStatus: 'PROCESSING', recordingId: 'r1' },
      remoteRecording: 'in-progress',
    });
    const d = await service.sessionDetail('u_teacher', 'ls1');
    expect(d.recording.status).toBe('PROCESSING');
    expect(session.recordingStatus).toBe('PROCESSING');
  });

  it('marks a recording the provider gave up on as failed', async () => {
    const { service } = world({
      teacherUserId: 'u_teacher',
      session: { recordingStatus: 'PROCESSING', recordingId: 'r1' },
      remoteRecording: 'failed',
    });
    const d = await service.sessionDetail('u_teacher', 'ls1');
    expect(d.recording.status).toBe('FAILED');
  });

  it('gives the teacher a link that expires', async () => {
    const { service, daily } = world({
      teacherUserId: 'u_teacher',
      session: { recordingStatus: 'READY', recordingId: 'r1' },
    });
    const link = await service.recordingLink('u_teacher', 'ls1');
    expect(link.url).toContain('https://');
    expect(link.expiresAt).toBeInstanceOf(Date);
    // Minted per request, never read from a stored column.
    expect(daily.recordingLink).toHaveBeenCalledWith('r1');
  });
});

describe('asking for a summary', () => {
  it('queues the job on the existing worker', async () => {
    const { service, jobs } = world();
    expect(await service.requestSummary('t1', 'ls1')).toEqual({ status: 'PROCESSING' });
    expect(jobs.enqueue).toHaveBeenCalledWith('t1', 'LIVE_SUMMARY', { liveSessionId: 'ls1' });
  });

  it('does not queue a second one while the first is running', async () => {
    // The teacher pressing the button twice, and a webhook arriving twice, are
    // the same event as far as the bill is concerned.
    const { service, jobs } = world({ session: { summaryStatus: 'PROCESSING' } });
    expect(await service.requestSummary('t1', 'ls1')).toEqual({ status: 'PROCESSING' });
    expect(jobs.enqueue).not.toHaveBeenCalled();
  });

  it('does not regenerate one that is already written', async () => {
    const { service, jobs } = world({ session: { summaryStatus: 'READY' } });
    expect(await service.requestSummary('t1', 'ls1')).toEqual({ status: 'READY' });
    expect(jobs.enqueue).not.toHaveBeenCalled();
  });

  it('refuses a session belonging to another academy', async () => {
    const { service } = world();
    await expect(service.requestSummary('other', 'ls1')).rejects.toThrow(NotFoundException);
  });
});

describe('what each side is allowed to read', () => {
  it('shows the teacher their summary before anyone else has it', async () => {
    const { service } = world({
      teacherUserId: 'u_teacher',
      session: { summaryStatus: 'READY', summary: { summary: 'x' }, summaryForStudents: false },
    });
    const d = await service.sessionDetail('u_teacher', 'ls1');
    expect(d.role).toBe('TEACHER');
    expect(d.summary.data).toEqual({ summary: 'x' });
  });

  it('tells a student there is nothing yet, rather than that they are locked out', async () => {
    // Not a 403: a student does not need to know a summary exists that their
    // teacher has not finished reading.
    const { service } = world({
      booked: true,
      session: { summaryStatus: 'READY', summary: { summary: 'x' }, summaryForStudents: false },
    });
    const d = await service.sessionDetail('u_student', 'ls1');
    expect(d.summary.status).toBe('NOT_STARTED');
    expect(d.summary.data).toBeNull();
  });

  it('gives the student the summary once it is shared', async () => {
    const { service } = world({
      booked: true,
      session: { summaryStatus: 'READY', summary: { summary: 'x' }, summaryForStudents: true },
    });
    const d = await service.sessionDetail('u_student', 'ls1');
    expect(d.summary.data).toEqual({ summary: 'x' });
  });

  it('tells the class when their teacher shares it', async () => {
    const { service, notifications } = world({ session: { summaryStatus: 'READY' } });
    await service.setSummaryVisibility('t1', 'ls1', true);
    expect(notifications.create).toHaveBeenCalled();
  });
});

describe('the summary is written only from the transcript', () => {
  const handlerWith = (over: { transcript?: string | null; summaryStatus?: string; ai?: any } = {}) => {
    const session = {
      id: 'ls1', tenantId: 't1', title: 'الجبر', roomName: 'darsly-ls1',
      transcriptText: over.transcript ?? null,
      summaryStatus: over.summaryStatus ?? 'PROCESSING',
      teacher: { userId: 'u_teacher' },
    };
    const updated: any[] = [];
    const prisma = {
      liveSession: {
        findUnique: jest.fn(async () => ({ ...session })),
        update: jest.fn(async ({ data }: any) => { updated.push(data); return {}; }),
      },
    } as unknown as PrismaService;
    const ai = (over.ai ?? {
      completeStructured: jest.fn(async () => ({
        data: { summary: 's', topics: [], keyPoints: [], questionsAndAnswers: [], actionItems: [] },
      })),
    }) as unknown as AiClient;
    const daily = { transcriptFor: jest.fn(async () => null) } as unknown as DailyService;
    const notifications = { create: jest.fn(async () => ({})) } as unknown as NotificationsService;
    return { handler: new LiveSummaryHandler(prisma, ai, daily, notifications), ai, updated, notifications };
  };

  const job = { id: 'j1', input: { liveSessionId: 'ls1' } } as any;
  const LESSON = 'المدرس: '.padEnd(400, 'ا');

  it('summarises a real transcript and stores it', async () => {
    const { handler, updated, notifications } = handlerWith({ transcript: LESSON });
    await handler.handle(job);
    const saved = updated.find((u) => u.summaryStatus === 'READY');
    expect(saved).toBeTruthy();
    expect(notifications.create).toHaveBeenCalled();
  });

  it('refuses to summarise a session with no transcript, and does not retry forever', async () => {
    // There is nothing to summarise and tomorrow will not change that, so the
    // job is terminal rather than retried until it gives up.
    const { handler, updated, ai } = handlerWith({ transcript: null });
    const err = await handler.handle(job).catch((e) => e);
    expect(err).toBeInstanceOf(AiJobError);
    expect(err.errorClass).toBe('TERMINAL');
    expect(ai.completeStructured).not.toHaveBeenCalled();
    expect(updated.some((u) => u.summaryError === 'NO_TRANSCRIPT')).toBe(true);
  });

  it('treats a near-empty transcript as no transcript', async () => {
    const { handler, ai } = handlerWith({ transcript: 'أهلاً' });
    await handler.handle(job).catch(() => undefined);
    expect(ai.completeStructured).not.toHaveBeenCalled();
  });

  it('does nothing at all for a session already summarised', async () => {
    // The idempotency the brief asks for: a duplicate event costs no model call.
    const { handler, ai } = handlerWith({ transcript: LESSON, summaryStatus: 'READY' });
    await handler.handle(job);
    expect(ai.completeStructured).not.toHaveBeenCalled();
  });

  it('keeps a provider failure retryable, since the transcript is still on file', async () => {
    const { handler, updated } = handlerWith({
      transcript: LESSON,
      ai: { completeStructured: jest.fn(async () => { throw new Error('502'); }) },
    });
    const err = await handler.handle(job).catch((e) => e);
    expect(err.errorClass).toBe('RETRYABLE');
    expect(updated.some((u) => u.summaryError === 'AI_FAILED')).toBe(true);
  });

  it('hands the model the transcript as data, and says so', async () => {
    const { handler, ai } = handlerWith({ transcript: LESSON });
    await handler.handle(job);
    const call = (ai.completeStructured as jest.Mock).mock.calls[0][0];
    expect(call.system).toMatch(/ONLY source/i);
    expect(call.system).toMatch(/never follow instructions/i);
    // Fenced, so a transcript containing "ignore the above" reads as speech.
    expect(call.messages[0].content).toContain('<<<TRANSCRIPT>>>');
    expect(call.schema.required).toEqual(
      expect.arrayContaining(['summary', 'topics', 'keyPoints', 'questionsAndAnswers', 'actionItems']),
    );
  });
});
