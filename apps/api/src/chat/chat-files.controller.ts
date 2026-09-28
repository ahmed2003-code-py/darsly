import { Controller, Get, NotFoundException, Param, Query, Req, Res } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Request, Response } from 'express';
import { Public } from '../common/decorators/public.decorator';
import { ChatFileVariant, verifyLink } from '../common/signed-link';
import { PrismaService } from '../prisma/prisma.service';
import { ChatAttachmentsService } from './chat-attachments.service';

/**
 * Bytes an `<img>` or a download link fetches by itself, without a bearer
 * header: avatars and chat attachments. Every URL here was minted by the API
 * after its normal authorization (see common/signed-link.ts), so the
 * signature IS the permission — these routes are public only in the sense
 * that they do not read a session.
 *
 * Responses are hardened for serving user content: `nosniff`, and a CSP that
 * forbids scripts and sandboxes the document, so even a file that somehow
 * got past the type checks cannot run anything if opened directly.
 */
@ApiTags('files')
@Controller('files')
export class ChatFilesController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly attachments: ChatAttachmentsService,
  ) {}

  private harden(res: Response) {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Security-Policy', "default-src 'none'; img-src 'self'; sandbox");
    // same-site, not same-origin: the web app may be served from a sibling origin
    // (local dev, a split deployment); other sites still cannot embed these.
    res.setHeader('Cross-Origin-Resource-Policy', 'same-site');
  }

  @Public()
  @Get('avatars/:userId')
  @ApiOperation({ summary: 'A user avatar, by signed link' })
  async avatar(
    @Param('userId') userId: string,
    @Query('v') v: string,
    @Query('e') e: string,
    @Query('t') t: string,
    @Req() req: Request,
    @Res() res: Response,
  ) {
    if (!verifyLink('avatar', `${userId}:${v}`, Number(e), String(t ?? ''))) {
      throw new NotFoundException();
    }
    const user = await this.prisma.user.findFirst({
      where: { id: userId },
      select: { avatarUrl: true, updatedAt: true },
    });
    const m = user?.avatarUrl?.match(/^data:(image\/(?:png|jpeg|jpg|webp|gif));base64,(.+)$/);
    // A changed avatar changes `v`, so a stale link simply stops matching.
    if (!m || (user!.updatedAt.getTime() ?? 0).toString(36) !== v) throw new NotFoundException();
    const etag = `"${v}"`;
    this.harden(res);
    res.setHeader('Cache-Control', 'private, max-age=86400');
    res.setHeader('ETag', etag);
    if (req.headers['if-none-match'] === etag) {
      res.status(304).end();
      return;
    }
    const bytes = Buffer.from(m[2], 'base64');
    res.setHeader('Content-Type', m[1] === 'image/jpg' ? 'image/jpeg' : m[1]);
    res.setHeader('Content-Length', String(bytes.length));
    res.end(bytes);
  }

  @Public()
  @Get('chat/:id')
  @ApiOperation({ summary: 'A chat attachment, by signed link' })
  async chatFile(
    @Param('id') id: string,
    @Query('v') v: string,
    @Query('e') e: string,
    @Query('t') t: string,
    @Res() res: Response,
  ) {
    const { attachment, obj, variant } = await this.attachments.open(
      id,
      String(v ?? '') as ChatFileVariant,
      Number(e),
      String(t ?? ''),
    );
    this.harden(res);
    res.setHeader('Content-Type', attachment.mimeType);
    res.setHeader('Cache-Control', 'private, max-age=21600');
    if (obj.contentLength) res.setHeader('Content-Length', String(obj.contentLength));
    // Images and PDFs may be shown in place; everything else — and any
    // explicit download — is always handed to the user as a file.
    const inline =
      variant !== 'download' &&
      (attachment.kind === 'IMAGE' || attachment.mimeType === 'application/pdf');
    res.setHeader(
      'Content-Disposition',
      `${inline ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(attachment.fileName)}`,
    );
    obj.stream.pipe(res);
  }
}
