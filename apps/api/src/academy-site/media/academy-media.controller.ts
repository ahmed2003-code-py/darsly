import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Post,
  Res,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiConsumes, ApiOperation, ApiTags } from '@nestjs/swagger';
import { AcademyMediaKind } from '@prisma/client';
import { Response } from 'express';
import { memoryStorage } from 'multer';
import { AcademyStaff } from '../../academy/academy-staff.decorator';
import { AcademyContext, CurrentAcademy } from '../../academy/academy-context';
import { Public } from '../../common/decorators/public.decorator';
import { StorageProvider } from '../../storage/storage.provider';
import { AcademyMediaService } from './academy-media.service';
import { UPLOADABLE_KINDS } from './dto/upload-media.dto';

const IMAGE_MIME = /^image\/(png|jpe?g|webp)$/;
const MAX_UPLOAD_BYTES = 10 * 1024 * 1024; // 10 MB

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
  @ApiOperation({ summary: '[staff] Upload an academy image (multipart: file, kind)' })
  @UseInterceptors(
    FileInterceptor('file', {
      storage: memoryStorage(),
      limits: { fileSize: MAX_UPLOAD_BYTES },
      fileFilter: (_req, file, cb) =>
        IMAGE_MIME.test(file.mimetype)
          ? cb(null, true)
          : cb(new BadRequestException('Only PNG, JPEG and WebP images are accepted'), false),
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
      throw new BadRequestException('kind must be one of LOGO, COVER, GALLERY, AVATAR');
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
  @ApiOperation({ summary: 'Public: stream a READY academy image' })
  async serve(@Param('id') id: string, @Res() res: Response) {
    const media = await this.media.getReadyForPublic(id);
    const obj = await this.storage.getStream(media.storageKey!);
    res.setHeader('Content-Type', media.mimeType ?? 'image/webp');
    res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    if (obj.contentLength) res.setHeader('Content-Length', String(obj.contentLength));
    obj.stream.pipe(res);
  }
}
