import {
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  Logger,
} from '@nestjs/common';
import { randomBytes } from 'node:crypto';
import { PrismaService } from '../../prisma/prisma.service';
import { DRM_PROVIDER, IDrmProvider } from '../../video/drm/drm.provider';
import { LiveService } from '../live.service';

/** However long the recording, a replay token is never good for longer than this. */
export const REPLAY_MAX_TTL_SEC = 4 * 3600;
/** Room past the recording's own length (pauses, seeking back). */
const REPLAY_SLACK_SEC = 30 * 60;

/**
 * Watching a live lesson's recording inside Darsly.
 *
 * The recording is a VideoAsset packaged by the existing pipeline as AES-128
 * encrypted HLS — the same files, the same signed-token delivery and the same
 * key endpoint as a course lesson. What differs is who may watch, so that is
 * all this adds: a LiveReplaySession (the replay's own PlaybackSession) and
 * the rule for opening one.
 *
 *  - The teacher side (the class's teacher, or staff of its academy) may
 *    always watch.
 *  - A student may watch when they were booked on the class AND the teacher
 *    shared the recording (recordingVisibility = STUDENTS) — the recording's
 *    own switch, not the summary's.
 *
 * No Lesson or Course row is invented for this: the replay points at the
 * asset directly, so turning a recording into course content later is a new
 * Lesson pointing at the same VideoAsset — no media is copied.
 *
 * The token is asset-bound and expires with the recording's length (plus
 * slack, capped); the key endpoint re-checks this row and the viewer's right
 * to watch before it hands over the content key.
 */
@Injectable()
export class LiveReplayService {
  private readonly logger = new Logger(LiveReplayService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly live: LiveService,
    @Inject(DRM_PROVIDER) private readonly drm: IDrmProvider,
  ) {}

  async start(
    user: { sub: string; sessionId?: string },
    liveSessionId: string,
    device: { ip?: string; userAgent?: string },
  ) {
    const { role } = await this.live.assertInSession(user.sub, liveSessionId);
    const s = await this.prisma.liveSession.findUniqueOrThrow({
      where: { id: liveSessionId },
      select: { id: true, provider: true, recordingVisibility: true, tenantId: true, academyId: true },
    });
    if (s.provider !== 'CLOUDFLARE') {
      // Daily's recordings are Daily's own (a short-lived provider link).
      throw new ConflictException({ message: 'Not a Darsly recording', code: 'RECORDING_USE_LINK' });
    }
    if (role === 'STUDENT' && s.recordingVisibility !== 'STUDENTS') {
      throw new ForbiddenException({ message: 'Recording not shared', code: 'RECORDING_NOT_SHARED' });
    }
    // The latest recording that finished — a later one that failed does not
    // hide one that is ready.
    const rec = await this.prisma.liveRecording.findFirst({
      where: { sessionId: liveSessionId, status: 'READY', videoAssetId: { not: null } },
      orderBy: { createdAt: 'desc' },
      select: { id: true, videoAssetId: true },
    });
    const asset = rec?.videoAssetId
      ? await this.prisma.videoAsset.findUnique({
          where: { id: rec.videoAssetId },
          select: { id: true, status: true, hlsMasterKey: true, durationSec: true },
        })
      : null;
    if (!rec || !asset || asset.status !== 'READY' || !asset.hlsMasterKey) {
      throw new ConflictException({ message: 'Recording not ready', code: 'RECORDING_NOT_READY' });
    }
    const base = Number(process.env.SIGNED_URL_TTL_SECONDS ?? 300);
    const ttlSec = Math.min(REPLAY_MAX_TTL_SEC, Math.max(base, asset.durationSec + REPLAY_SLACK_SEC));
    const watermarkId = `DRS-L-${randomBytes(4).toString('hex').toUpperCase()}`;
    const viewer = await this.prisma.user.findUnique({
      where: { id: user.sub },
      select: { fullName: true },
    });
    const replay = await this.prisma.liveReplaySession.create({
      data: {
        watermarkId,
        liveSessionId,
        recordingId: rec.id,
        videoAssetId: asset.id,
        userId: user.sub,
        role,
        tenantId: s.academyId ?? s.tenantId,
        deviceSessionId: user.sessionId ?? null,
        ip: device.ip ?? null,
        userAgent: device.userAgent?.slice(0, 300) ?? null,
        expiresAt: new Date(Date.now() + ttlSec * 1000),
      },
    });
    const creds = await this.drm.issueCredentials({
      assetId: asset.id,
      studentId: user.sub,
      sessionId: replay.id,
      watermarkId,
      resource: 'LIVE_RECORDING',
      ttlSec,
    });
    this.logger.log(
      `live.replay.started liveSession=${liveSessionId} replay=${replay.id} role=${role} asset=${asset.id} ttl=${ttlSec}s`,
    );
    return {
      replaySessionId: replay.id,
      scheme: creds.scheme,
      masterUrl: creds.masterUrl,
      durationSec: asset.durationSec,
      expiresAt: replay.expiresAt,
      watermark: { name: viewer?.fullName ?? '', watermarkId },
    };
  }

  /** The viewer closed the player: the key is refused from now on. */
  async end(userId: string, liveSessionId: string, replayId: string) {
    const r = await this.prisma.liveReplaySession.updateMany({
      where: { id: replayId, userId, liveSessionId, endedAt: null },
      data: { endedAt: new Date() },
    });
    return { ended: r.count > 0 };
  }
}
