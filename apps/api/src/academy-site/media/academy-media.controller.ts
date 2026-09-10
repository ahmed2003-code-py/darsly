import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Post,
  Req,
  Res,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiConsumes, ApiOperation, ApiTags } from '@nestjs/swagger';
import { AcademyMediaKind } from '@prisma/client';
import { Request, Response } from 'express';
import { memoryStorage } from 'multer';
import { AcademyStaff } from '../../academy/academy-staff.decorator';
import { AcademyContext, CurrentAcademy } from '../../academy/academy-context';
import { Public } from '../../common/decorators/public.decorator';
import { StorageProvider } from '../../storage/storage.provider';
import { AcademyMediaService } from './academy-media.service';
import { UPLOADABLE_KINDS } from './dto/upload-media.dto';

const IMAGE_MIME = /^image\/(png|jpe?g|webp)$/;
const VIDEO_MIME = /^video\/mp4$/;
// The blanket ceiling multer enforces before `kind` (and so the real per-type
// limit) is known; AcademyMediaService/AcademyMediaProcessor apply the tighter,
// kind-specific limit once it is.
const MAX_UPLOAD_BYTES = 25 * 1024 * 1024; // 25 MB (PROMO video is the largest kind)

@ApiTags('academy-studio/media')
@Controller()
export class AcademyMediaController {
  constructor(
    private readonly media: AcademyMediaService,
    private readonly storage: StorageProvider,
  ) {}

  @Post('academy/media')
  @AcademyStaff('academy.manage')
  @ApiConsumes('multipart/form-data')
  @ApiOperation({ summary: '[staff] Upload an academy image or PROMO clip (multipart: file, kind)' })
  @UseInterceptors(
    FileInterceptor('file', {
      storage: memoryStorage(),
      limits: { fileSize: MAX_UPLOAD_BYTES },
      // `kind` decides which type is actually required, but multer's fileFilter
      // runs before the body is necessarily parsed, so it only rejects what is
      // never acceptable; the exact image-vs-MP4 mismatch is a clearer 400 from
      // AcademyMediaService/AcademyMediaProcessor, which do know `kind`.
      fileFilter: (_req, file, cb) =>
        IMAGE_MIME.test(file.mimetype) || VIDEO_MIME.test(file.mimetype)
          ? cb(null, true)
          : cb(new BadRequestException('Only PNG, JPEG, WebP images or MP4 video are accepted'), false),
    }),
  )
  async upload(
    @CurrentAcademy() ctx: AcademyContext,
    @UploadedFile() file: Express.Multer.File | undefined,
    // `kind` arrives as a multipart text field on the body; validated explicitly
    // here since the multipart request skips the global transforming pipe.
    @Body('kind') kind: string,
  ) {
    if (!file) throw new BadRequestException('file is required');
    if (!UPLOADABLE_KINDS.includes(kind as AcademyMediaKind)) {
      throw new BadRequestException('kind must be one of LOGO, COVER, GALLERY, AVATAR, PROMO');
    }
    return this.media.upload(ctx.academyId, kind as AcademyMediaKind, {
      buffer: file.buffer,
      mimetype: file.mimetype,
    });
  }

  @Get('academy/media')
  @AcademyStaff('academy.manage')
  @ApiOperation({ summary: '[staff] List academy media' })
  list(@CurrentAcademy() ctx: AcademyContext) {
    return this.media.list(ctx.academyId);
  }

  @Get('academy/media/:id')
  @AcademyStaff('academy.manage')
  @ApiOperation({ summary: '[staff] Get a single media item (poll processing status)' })
  getOne(@CurrentAcademy() ctx: AcademyContext, @Param('id') id: string) {
    return this.media.get(ctx.academyId, id);
  }

  @Delete('academy/media/:id')
  @AcademyStaff('academy.manage')
  @ApiOperation({ summary: '[staff] Delete a media item' })
  remove(@CurrentAcademy() ctx: AcademyContext, @Param('id') id: string) {
    return this.media.remove(ctx.academyId, id);
  }

  @Get('files/academy-media/:id')
  @Public()
  @ApiOperation({ summary: 'Public: stream a READY academy image or PROMO clip' })
  async serve(@Param('id') id: string, @Req() req: Request, @Res() res: Response) {
    const media = await this.media.getReadyForPublic(id);
    // Range support matters for PROMO (video) — without it a browser can only
    // fetch the whole clip before it seeks; images ignore the header.
    const range = this.parseRange(req.headers['range']);
    const obj = await this.storage.getStream(media.storageKey!, range ?? undefined);
    res.setHeader('Content-Type', media.mimeType ?? 'image/webp');
    res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    res.setHeader('Accept-Ranges', 'bytes');
    if (obj.range) {
      res.status(206);
      res.setHeader('Content-Range', `bytes ${obj.range.start}-${obj.range.end}/${obj.totalSize}`);
    }
    res.setHeader('Content-Length', String(obj.contentLength));
    obj.stream.pipe(res);
  }

  private parseRange(header?: string): { start: number; end?: number } | null {
    if (!header?.startsWith('bytes=')) return null;
    const [s, e] = header.replace('bytes=', '').split('-');
    const start = Number(s);
    if (Number.isNaN(start)) return null;
    return { start, end: e ? Number(e) : undefined };
  }
}
