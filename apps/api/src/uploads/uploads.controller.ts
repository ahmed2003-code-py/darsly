import {
  BadRequestException,
  Controller,
  Delete,
  Get,
  NotFoundException,
  Param,
  Post,
  Res,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiBearerAuth, ApiBody, ApiConsumes, ApiOperation, ApiTags } from '@nestjs/swagger';
import { JwtPayload, Role } from '@darsly/shared-types';
import { Response } from 'express';
import * as fs from 'fs';
import { diskStorage } from 'multer';
import * as path from 'path';
import * as os from 'os';
import { AuditService } from '../audit/audit.service';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { Roles } from '../common/decorators/roles.decorator';
import { PrismaService } from '../prisma/prisma.service';
import { StorageProvider } from '../storage/storage.provider';
import { VideoProcessingService } from '../video/video-processing.service';

const STORAGE_ROOT = path.resolve(process.env.STORAGE_LOCAL_PATH ?? './storage');

function storageFor(subdir: string) {
  return diskStorage({
    destination: (_req, _file, cb) => {
      const dir = path.join(STORAGE_ROOT, subdir);
      fs.mkdirSync(dir, { recursive: true });
      cb(null, dir);
    },
    filename: (_req, file, cb) => {
      const ext = path.extname(file.originalname).toLowerCase().slice(0, 10);
      cb(null, `${Date.now()}-${Math.random().toString(36).slice(2, 10)}${ext}`);
    },
  });
}

const VIDEO_MIME = /^video\/(mp4|webm|quicktime|x-matroska)$/;
const ATTACHMENT_MIME =
  /^(application\/pdf|image\/(png|jpe?g|webp)|application\/(zip|msword|vnd\.openxmlformats-officedocument\..+)|text\/plain)$/;

/**
 * Upload pipeline. Videos are staged, stored as a private source object, then
 * transcoded to AES-128 encrypted HLS by VideoProcessingService (raw source is
 * deleted once packaging succeeds and is never served). Attachments are
 * streamed back only to the owner teacher, enrolled students, or anyone for
 * free-preview lessons.
 */
@ApiTags('uploads')
@Controller()
export class UploadsController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly storage: StorageProvider,
    private readonly videoProcessing: VideoProcessingService,
  ) {}

  @Post('uploads/videos')
  @Roles(Role.TEACHER)
  @ApiBearerAuth()
  @ApiConsumes('multipart/form-data')
  @ApiBody({
    schema: {
      type: 'object',
      properties: { file: { type: 'string', format: 'binary' } },
    },
  })
  @ApiOperation({ summary: '[teacher] Upload a lesson video (multipart field: file)' })
  @UseInterceptors(
    FileInterceptor('file', {
      // Stage to the OS temp dir; the handler moves it into private storage.
      storage: diskStorage({ destination: os.tmpdir() }),
      limits: { fileSize: 2 * 1024 * 1024 * 1024 }, // 2 GB
      fileFilter: (_req, file, cb) =>
        VIDEO_MIME.test(file.mimetype)
          ? cb(null, true)
          : cb(new BadRequestException('Only mp4/webm/mov/mkv videos are accepted'), false),
    }),
  )
  async uploadVideo(@CurrentUser() user: JwtPayload, @UploadedFile() file?: Express.Multer.File) {
    if (!file) throw new BadRequestException('file is required');

    // Create the asset first (UPLOADING) so we can key the source object by id,
    // then move the staged upload into private storage under source/<id>.
    const ext = path.extname(file.originalname).toLowerCase().slice(0, 10) || '.mp4';
    const asset = await this.prisma.videoAsset.create({
      data: {
        tenantId: user.tenantId!,
        originalKey: '', // set below
        sizeBytes: BigInt(file.size),
        status: 'UPLOADING',
      },
    });
    const sourceKey = `source/${asset.id}${ext}`;
    await this.storage.put(sourceKey, fs.createReadStream(file.path), {
      contentType: file.mimetype,
    });
    fs.unlink(file.path, () => undefined);
    await this.prisma.videoAsset.update({
      where: { id: asset.id },
      data: { originalKey: sourceKey },
    });

    await this.audit.log({
      actorUserId: user.sub,
      action: 'video.upload',
      entity: 'VideoAsset',
      entityId: asset.id,
      meta: { sizeBytes: file.size, mimeType: file.mimetype },
    });

    // Transcode to encrypted HLS off the request thread.
    this.videoProcessing.enqueue(asset.id);
    return {
      id: asset.id,
      status: 'PROCESSING',
      sizeBytes: file.size,
      fileName: file.originalname,
    };
  }

  @Get('uploads/videos/:id/status')
  @Roles(Role.TEACHER)
  @ApiBearerAuth()
  @ApiOperation({ summary: '[teacher] Poll transcode status of a video asset' })
  async videoStatus(@CurrentUser() user: JwtPayload, @Param('id') id: string) {
    const asset = await this.prisma.videoAsset.findFirst({
      where: { id, tenantId: user.tenantId },
      select: { id: true, status: true, durationSec: true, renditions: true },
    });
    if (!asset) throw new NotFoundException('Video asset not found');
    return asset;
  }

  @Post('uploads/lessons/:lessonId/attachments')
  @Roles(Role.TEACHER)
  @ApiBearerAuth()
  @ApiConsumes('multipart/form-data')
  @ApiBody({
    schema: {
      type: 'object',
      properties: { file: { type: 'string', format: 'binary' } },
    },
  })
  @ApiOperation({ summary: '[teacher] Attach a PDF/document/image to a lesson' })
  @UseInterceptors(
    FileInterceptor('file', {
      storage: storageFor('attachments'),
      limits: { fileSize: 50 * 1024 * 1024 }, // 50 MB
      fileFilter: (_req, file, cb) =>
        ATTACHMENT_MIME.test(file.mimetype)
          ? cb(null, true)
          : cb(new BadRequestException('Unsupported attachment type'), false),
    }),
  )
  async uploadAttachment(
    @CurrentUser() user: JwtPayload,
    @Param('lessonId') lessonId: string,
    @UploadedFile() file?: Express.Multer.File,
  ) {
    if (!file) throw new BadRequestException('file is required');
    const lesson = await this.prisma.lesson.findFirst({
      where: { id: lessonId, unit: { course: { tenantId: user.tenantId } } },
    });
    if (!lesson) {
      fs.unlink(file.path, () => undefined);
      throw new NotFoundException('Lesson not found');
    }
    // Multer decodes originalname as latin1; recover Arabic filenames.
    const fileName = Buffer.from(file.originalname, 'latin1').toString('utf8');
    return this.prisma.attachment.create({
      data: {
        lessonId,
        fileName,
        storageKey: path.relative(STORAGE_ROOT, file.path),
        mimeType: file.mimetype,
        sizeBytes: file.size,
      },
    });
  }

  @Delete('uploads/attachments/:id')
  @Roles(Role.TEACHER)
  @ApiBearerAuth()
  @ApiOperation({ summary: '[teacher] Remove an attachment' })
  async removeAttachment(@CurrentUser() user: JwtPayload, @Param('id') id: string) {
    const attachment = await this.prisma.attachment.findFirst({
      where: { id, lesson: { unit: { course: { tenantId: user.tenantId } } } },
    });
    if (!attachment) throw new NotFoundException('Attachment not found');
    await this.prisma.attachment.delete({ where: { id } });
    fs.unlink(path.join(STORAGE_ROOT, attachment.storageKey), () => undefined);
    return { id, deleted: true };
  }

  @Get('files/attachments/:id')
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Download an attachment (owner teacher, enrolled student, or free preview)' })
  async downloadAttachment(
    @CurrentUser() user: JwtPayload,
    @Param('id') id: string,
    @Res() res: Response,
  ) {
    const attachment = await this.prisma.attachment.findUnique({
      where: { id },
      include: { lesson: { include: { unit: { include: { course: true } } } } },
    });
    if (!attachment) throw new NotFoundException('Attachment not found');

    const course = attachment.lesson.unit.course;
    let allowed =
      user.role === Role.SUPER_ADMIN ||
      user.tenantId === course.tenantId ||
      attachment.lesson.isFreePreview;

    if (!allowed && user.role === Role.STUDENT) {
      const student = await this.prisma.studentProfile.findUnique({ where: { userId: user.sub } });
      if (student) {
        const enrollment = await this.prisma.enrollment.findUnique({
          where: { studentId_courseId: { studentId: student.id, courseId: course.id } },
        });
        allowed =
          enrollment?.status === 'ACTIVE' &&
          (!enrollment.expiresAt || enrollment.expiresAt > new Date());
      }
    }
    if (!allowed) throw new NotFoundException('Attachment not found');

    const filePath = path.join(STORAGE_ROOT, attachment.storageKey);
    if (!fs.existsSync(filePath)) throw new NotFoundException('File missing from storage');

    res.setHeader('Content-Type', attachment.mimeType);
    res.setHeader(
      'Content-Disposition',
      `attachment; filename*=UTF-8''${encodeURIComponent(attachment.fileName)}`,
    );
    fs.createReadStream(filePath).pipe(res);
  }
}
