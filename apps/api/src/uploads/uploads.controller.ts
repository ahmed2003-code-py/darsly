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
import { assertFileMatchesMime } from '../common/file-signature';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { Roles } from '../common/decorators/roles.decorator';
import { PrismaService } from '../prisma/prisma.service';
import { StorageProvider } from '../storage/storage.provider';
import { VideoProcessingService } from '../video/video-processing.service';

/**
 * Where an upload lands first: the OS temp dir, never the storage root.
 *
 * Attachments used to be written by multer straight into `STORAGE_LOCAL_PATH`
 * and read back with `fs`, around the storage provider entirely — which
 * worked on a disk and would have silently kept working on the disk with
 * `STORAGE_DRIVER=s3` set, while every other file went to the bucket. They
 * stage here and go through `storage.put` like the videos do.
 */
const staged = diskStorage({ destination: os.tmpdir() });

/** A key that says what it is and cannot collide with another upload. */
function attachmentKey(originalname: string): string {
  const ext = path.extname(originalname).toLowerCase().slice(0, 10);
  return `attachments/${Date.now()}-${Math.random().toString(36).slice(2, 10)}${ext}`;
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
  /**
   * Refuse a file whose content does not match its declared type, and do not
   * leave the staged copy behind when refusing.
   *
   * Every early return in this controller unlinks the temp file; a new one
   * that forgot would leak a 2 GB upload onto the container's disk, so the
   * cleanup lives with the check rather than at each call site.
   */
  private async rejectMismatch(file: Express.Multer.File): Promise<void> {
    try {
      await assertFileMatchesMime(file.path, file.mimetype);
    } catch (e) {
      fs.unlink(file.path, () => undefined);
      throw e;
    }
  }

  async uploadVideo(@CurrentUser() user: JwtPayload, @UploadedFile() file?: Express.Multer.File) {
    if (!file) throw new BadRequestException('file is required');
    // The filter above checked the type the client *declared*; this checks the
    // bytes. Done here rather than in fileFilter because multer has not written
    // the body yet when that runs — there is nothing to read until now.
    await this.rejectMismatch(file);

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
      storage: staged,
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
    await this.rejectMismatch(file);
    const lesson = await this.prisma.lesson.findFirst({
      where: { id: lessonId, unit: { course: { tenantId: user.tenantId } } },
    });
    if (!lesson) {
      fs.unlink(file.path, () => undefined);
      throw new NotFoundException('Lesson not found');
    }
    // Multer decodes originalname as latin1; recover Arabic filenames.
    const fileName = Buffer.from(file.originalname, 'latin1').toString('utf8');
    const storageKey = attachmentKey(file.originalname);
    try {
      await this.storage.put(storageKey, fs.createReadStream(file.path), { contentType: file.mimetype });
    } finally {
      fs.unlink(file.path, () => undefined);
    }
    return this.prisma.attachment.create({
      data: {
        lessonId,
        fileName,
        storageKey,
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
    // The row soft-deletes, so the file stays: a teacher who removes the wrong
    // handout gets it back by clearing `deletedAt`, the same way a removed
    // lesson keeps its video. Unlinking here would leave the delete soft in
    // name only — hidden, unrecoverable, and still holding a row that points
    // at nothing.
    await this.prisma.attachment.delete({ where: { id } });
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
    // `findFirst`, not `findUnique`: the soft-delete filter only runs on the
    // former, and this route is reachable by anyone holding the id. Looked up
    // by primary key it would keep serving a file the teacher had removed.
    const attachment = await this.prisma.attachment.findFirst({
      where: { id },
      include: { lesson: { include: { unit: { include: { course: true } } } } },
    });
    if (!attachment) throw new NotFoundException('Attachment not found');

    // Nested includes are not filtered either, so the parents are checked by
    // hand. Removing a lesson leaves its attachments' own rows untouched; with
    // no check here, every handout under a deleted lesson stays downloadable
    // to anyone who kept the link.
    const course = attachment.lesson.unit.course;
    if (attachment.lesson.deletedAt || attachment.lesson.unit.deletedAt || course.deletedAt) {
      throw new NotFoundException('Attachment not found');
    }
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

    if (!(await this.storage.exists(attachment.storageKey))) {
      throw new NotFoundException('File missing from storage');
    }
    const obj = await this.storage.getStream(attachment.storageKey);
    res.setHeader('Content-Type', attachment.mimeType);
    if (obj.contentLength) res.setHeader('Content-Length', String(obj.contentLength));
    res.setHeader(
      'Content-Disposition',
      `attachment; filename*=UTF-8''${encodeURIComponent(attachment.fileName)}`,
    );
    obj.stream.pipe(res);
  }
}
