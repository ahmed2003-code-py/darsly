import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  Inject,
  NotFoundException,
  Param,
  Post,
  Req,
  Res,
  UnauthorizedException,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { JwtPayload, Role } from '@darsly/shared-types';
import { IsInt, IsObject, IsOptional, IsString, Min } from 'class-validator';
import { Request, Response } from 'express';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { Public } from '../common/decorators/public.decorator';
import { Roles } from '../common/decorators/roles.decorator';
import { PrismaService } from '../prisma/prisma.service';
import { HlsKeyService } from '../video/hls-key.service';
import { StorageProvider } from '../storage/storage.provider';
import { PlaybackService } from './playback.service';
import { KEY_URI_PLACEHOLDER } from '../video/transcode.service';
import { SignedUrlService } from './signed-url.service';

class StartSessionDto {
  @IsString() lessonId: string;
}
class HeartbeatDto {
  @IsInt() @Min(0) positionSec: number;
  @IsString() type: string; // play | pause | seek | hb
  @IsOptional() @IsInt() watchedPct?: number;
}
class ReportEventDto {
  @IsString() type: string; // devtools | ...
  @IsOptional() @IsObject() meta?: Record<string, unknown>;
}

function ctx(req: Request) {
  return {
    ip: (req.headers['x-forwarded-for'] as string)?.split(',')[0]?.trim() || req.ip,
    userAgent: req.headers['user-agent'],
  };
}

/**
 * Secure video delivery. Session control endpoints are bearer-authed; the HLS
 * playlist/segment/key endpoints authenticate via the short-lived signed token
 * in the URL (hls.js can't attach bearer headers to media requests), plus an
 * optional Referer allow-list. The AES key is served ONLY to a live authorized
 * session and never bundled into the media.
 */
@ApiTags('playback')
@Controller('playback')
export class PlaybackController {
  constructor(
    private readonly playback: PlaybackService,
    private readonly signer: SignedUrlService,
    private readonly storage: StorageProvider,
    private readonly keys: HlsKeyService,
    private readonly prisma: PrismaService,
  ) {}

  // ── Session control (bearer) ──────────────────────────────────────────────

  @Post('sessions')
  @Roles(Role.STUDENT, Role.TEACHER)
  @ApiBearerAuth()
  @HttpCode(200)
  @ApiOperation({ summary: 'Start a protected playback session (issues signed HLS + watermark)' })
  start(@CurrentUser() user: JwtPayload, @Body() dto: StartSessionDto, @Req() req: Request) {
    return this.playback.startSession(user, dto.lessonId, ctx(req));
  }

  @Post('sessions/:id/heartbeat')
  @Roles(Role.STUDENT, Role.TEACHER)
  @ApiBearerAuth()
  @HttpCode(200)
  @ApiOperation({ summary: 'Playback telemetry + progress; drives anomaly detection' })
  heartbeat(
    @CurrentUser() user: JwtPayload,
    @Param('id') id: string,
    @Body() dto: HeartbeatDto,
    @Req() req: Request,
  ) {
    return this.playback.heartbeat(user, id, dto, ctx(req));
  }

  @Post('sessions/:id/event')
  @Roles(Role.STUDENT, Role.TEACHER)
  @ApiBearerAuth()
  @HttpCode(200)
  @ApiOperation({ summary: 'Report a client hardening signal (e.g. devtools open)' })
  event(@CurrentUser() user: JwtPayload, @Param('id') id: string, @Body() dto: ReportEventDto) {
    return this.playback.reportEvent(user, id, dto);
  }

  @Post('sessions/:id/end')
  @Roles(Role.STUDENT, Role.TEACHER)
  @ApiBearerAuth()
  @HttpCode(200)
  @ApiOperation({ summary: 'End a playback session' })
  end(@CurrentUser() user: JwtPayload, @Param('id') id: string) {
    return this.playback.endSession(user, id);
  }

  // ── HLS delivery (signed token in URL) ────────────────────────────────────

  private assertReferer(referer?: string) {
    // Optional domain lock: only allow media requests originating from our web
    // origins. hls.js sends Referer; a hotlinked player from another site is
    // rejected. (A determined attacker can spoof Referer — this is a deterrent.)
    const allow = (process.env.ALLOWED_ORIGINS ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    if (!allow.length || !referer) return;
    if (!allow.some((o) => referer.startsWith(o))) {
      throw new UnauthorizedException('Referrer not allowed');
    }
  }

  @Public()
  @Get('hls/:token/master.m3u8')
  @ApiOperation({ summary: 'Master playlist (signed token)' })
  async master(
    @Param('token') token: string,
    @Headers('referer') referer: string,
    @Res() res: Response,
  ) {
    this.assertReferer(referer);
    const claims = this.signer.verify(token);
    const key = `hls/${claims.aid}/master.m3u8`;
    this.signer.assertKeyBelongsToAsset(claims, key);
    if (!(await this.storage.exists(key))) throw new NotFoundException('Playlist not found');
    const text = (await this.storage.getBuffer(key)).toString('utf8');
    res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
    res.setHeader('Cache-Control', 'no-store');
    res.send(text);
  }

  @Public()
  @Get('hls/:token/:rendition/:file')
  @ApiOperation({ summary: 'Media playlist or encrypted segment (signed token)' })
  async media(
    @Param('token') token: string,
    @Param('rendition') rendition: string,
    @Param('file') file: string,
    @Headers('referer') referer: string,
    @Req() req: Request,
    @Res() res: Response,
  ) {
    this.assertReferer(referer);
    const claims = this.signer.verify(token);
    const key = `hls/${claims.aid}/${rendition}/${file}`;
    this.signer.assertKeyBelongsToAsset(claims, key);
    if (!(await this.storage.exists(key))) throw new NotFoundException('Segment not found');

    if (file.endsWith('.m3u8')) {
      // Rewrite the placeholder key URI to this session's signed key endpoint.
      let text = (await this.storage.getBuffer(key)).toString('utf8');
      text = text.replace(
        new RegExp(KEY_URI_PLACEHOLDER, 'g'),
        `/api/v1/playback/key/${token}`,
      );
      res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
      res.setHeader('Cache-Control', 'no-store');
      return res.send(text);
    }

    // Encrypted .ts segment — stream with Range support.
    const range = this.parseRange(req.headers['range']);
    const obj = await this.storage.getStream(key, range ?? undefined);
    res.setHeader('Content-Type', 'video/mp2t');
    res.setHeader('Accept-Ranges', 'bytes');
    res.setHeader('Cache-Control', 'private, max-age=31536000');
    if (obj.range) {
      res.status(206);
      res.setHeader('Content-Range', `bytes ${obj.range.start}-${obj.range.end}/${obj.totalSize}`);
    }
    res.setHeader('Content-Length', obj.contentLength);
    obj.stream.pipe(res);
  }

  @Public()
  @Get('key/:token')
  @ApiOperation({ summary: 'AES-128 content key — only to a live authorized session' })
  async key(
    @Param('token') token: string,
    @Headers('referer') referer: string,
    @Res() res: Response,
  ) {
    this.assertReferer(referer);
    const claims = this.signer.verify(token);

    // Students: the PlaybackSession must still be live (not ended) and its
    // device session not revoked. Preview tokens (pv=1) skip this.
    if (!claims.pv) {
      const session = await this.prisma.playbackSession.findUnique({
        where: { id: claims.sid },
        include: { deviceSession: { select: { revokedAt: true } } },
      });
      if (!session || session.endedAt) throw new UnauthorizedException('Session not active');
      if (session.deviceSession?.revokedAt) throw new UnauthorizedException('Device revoked');
      if (session.watermarkId !== claims.wm) throw new UnauthorizedException('Token mismatch');
    }

    const asset = await this.prisma.videoAsset.findUnique({ where: { id: claims.aid } });
    if (!asset?.encryptionKeyId) throw new NotFoundException('No key for asset');
    const keyBytes = await this.keys.getKeyBytes(asset.encryptionKeyId);
    if (!keyBytes) throw new NotFoundException('Key not found');

    res.setHeader('Content-Type', 'application/octet-stream');
    res.setHeader('Cache-Control', 'no-store');
    res.send(keyBytes);
  }

  private parseRange(header?: string): { start: number; end?: number } | null {
    if (!header?.startsWith('bytes=')) return null;
    const [s, e] = header.replace('bytes=', '').split('-');
    const start = Number(s);
    if (Number.isNaN(start)) return null;
    return { start, end: e ? Number(e) : undefined };
  }
}
