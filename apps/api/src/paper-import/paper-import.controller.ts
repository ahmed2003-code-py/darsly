import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Post,
  Put,
  Res,
  UploadedFiles,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FilesInterceptor } from '@nestjs/platform-express';
import { memoryStorage } from 'multer';
import { ApiBearerAuth, ApiConsumes, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Response } from 'express';
import { JwtPayload } from '@darsly/shared-types';
import { AcademyContext, CurrentAcademy, RequirePermission } from '../academy/academy-context';
import { AcademyMembershipGuard } from '../academy/guards/academy-membership.guard';
import { PermissionGuard } from '../academy/guards/permission.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { ConfirmImportDto, SaveDraftDto } from './dto/paper-import.dto';
import { ExamExportService } from './exam-export.service';
import { ImportScope, PaperImportService } from './paper-import.service';

/** The multer ceiling. A second, tighter, per-kind limit is enforced in the
 *  service — this one only stops a body big enough to be a denial of service
 *  from being read into memory at all. */
const MAX_UPLOAD_BYTES = 40 * 1024 * 1024;
const MAX_FILES = 30;
const ACCEPTED = /^(image\/(png|jpe?g|webp)|application\/pdf)$/;

/**
 * Paper exam import, for teachers.
 *
 * Authorization is the platform's ordinary one and nothing else: the academy
 * is resolved by `AcademyMembershipGuard` (from X-Academy-Id, the subdomain,
 * or the owner's JWT) and `course.write` is required in it, exactly as on
 * `TeacherCoursesController`. Every route below then scopes its query by that
 * academy, so a teacher cannot read, retry, export or confirm anything but
 * their own — and a Center owner sees their Center's, the same rule that
 * governs courses.
 */
@ApiTags('paper-import')
@ApiBearerAuth()
@UseGuards(AcademyMembershipGuard, PermissionGuard)
@RequirePermission('course.write')
@Controller('teacher')
export class PaperImportController {
  constructor(
    private readonly imports: PaperImportService,
    private readonly exports: ExamExportService,
  ) {}

  private scope(user: JwtPayload, ctx: AcademyContext): ImportScope {
    return {
      academyId: ctx.academyId,
      authorTenantId: user.tenantId,
      manageAll: ctx.role === 'OWNER',
      userId: user.sub,
    };
  }

  @Post('paper-imports')
  @ApiConsumes('multipart/form-data')
  @ApiOperation({ summary: '[teacher] Upload photos of a paper exam, or one PDF' })
  @UseInterceptors(
    FilesInterceptor('files', MAX_FILES, {
      // Kept in memory: the pages are validated, normalised and handed to the
      // storage provider in this request, and never touch the storage root as
      // raw uploads the way an attachment used to.
      storage: memoryStorage(),
      limits: { fileSize: MAX_UPLOAD_BYTES, files: MAX_FILES },
      fileFilter: (_req, file, cb) =>
        ACCEPTED.test(file.mimetype)
          ? cb(null, true)
          : cb(new BadRequestException('Pages must be images or a PDF'), false),
    }),
  )
  create(
    @CurrentUser() user: JwtPayload,
    @CurrentAcademy() ctx: AcademyContext,
    @UploadedFiles() files?: Express.Multer.File[],
  ) {
    return this.imports.create(this.scope(user, ctx), files ?? []);
  }

  @Get('paper-imports')
  @ApiOperation({ summary: '[teacher] My paper imports' })
  list(@CurrentUser() user: JwtPayload, @CurrentAcademy() ctx: AcademyContext) {
    return this.imports.list(this.scope(user, ctx));
  }

  @Get('paper-imports/:id')
  @ApiOperation({ summary: '[teacher] One import: progress, draft and warnings' })
  get(
    @CurrentUser() user: JwtPayload,
    @CurrentAcademy() ctx: AcademyContext,
    @Param('id') id: string,
  ) {
    return this.imports.get(this.scope(user, ctx), id);
  }

  /** The page itself, so the review screen can show a question beside the
   *  paper it was read from. Authorized like everything else here — there is
   *  no signed-link shortcut, because these are somebody's exam papers. */
  @Get('paper-imports/:id/pages/:pageId/source')
  @ApiOperation({ summary: '[teacher] The uploaded page behind an extraction' })
  async source(
    @CurrentUser() user: JwtPayload,
    @CurrentAcademy() ctx: AcademyContext,
    @Param('id') id: string,
    @Param('pageId') pageId: string,
    @Res() res: Response,
  ) {
    const { page, object } = await this.imports.openPage(this.scope(user, ctx), id, pageId);
    res.setHeader('Content-Type', object.contentType ?? 'image/jpeg');
    if (object.contentLength) res.setHeader('Content-Length', String(object.contentLength));
    // Private: this is a teacher's unpublished exam paper.
    res.setHeader('Cache-Control', 'private, max-age=600');
    res.setHeader('Content-Disposition', `inline; filename="page-${page.pageNumber}.jpg"`);
    object.stream.pipe(res);
  }

  @Put('paper-imports/:id/draft')
  @ApiOperation({ summary: '[teacher] Save the reviewed draft' })
  saveDraft(
    @CurrentUser() user: JwtPayload,
    @CurrentAcademy() ctx: AcademyContext,
    @Param('id') id: string,
    @Body() dto: SaveDraftDto,
  ) {
    return this.imports.saveDraft(this.scope(user, ctx), id, dto);
  }

  @Post('paper-imports/:id/retry')
  @ApiOperation({ summary: '[teacher] Read the failed pages again (only those)' })
  retry(
    @CurrentUser() user: JwtPayload,
    @CurrentAcademy() ctx: AcademyContext,
    @Param('id') id: string,
  ) {
    return this.imports.retry(this.scope(user, ctx), id);
  }

  @Post('paper-imports/:id/confirm')
  @ApiOperation({ summary: '[teacher] Turn the draft into a real exam' })
  confirm(
    @CurrentUser() user: JwtPayload,
    @CurrentAcademy() ctx: AcademyContext,
    @Param('id') id: string,
    @Body() dto: ConfirmImportDto,
  ) {
    return this.imports.confirm(this.scope(user, ctx), id, dto);
  }

  @Delete('paper-imports/:id')
  @ApiOperation({ summary: '[teacher] Abandon an import' })
  remove(
    @CurrentUser() user: JwtPayload,
    @CurrentAcademy() ctx: AcademyContext,
    @Param('id') id: string,
  ) {
    return this.imports.remove(this.scope(user, ctx), id);
  }

  // ── export ───────────────────────────────────────────────────────────────
  //
  // Any exam, not just an imported one: these read a QUIZ lesson, so an exam
  // typed in by hand prints and exports exactly the same way.

  @Get('lessons/:lessonId/exam/document')
  @ApiOperation({ summary: '[teacher] The exam as a printable document model' })
  document(
    @CurrentUser() user: JwtPayload,
    @CurrentAcademy() ctx: AcademyContext,
    @Param('lessonId') lessonId: string,
  ) {
    return this.exports.document(this.scope(user, ctx), lessonId);
  }

  @Get('lessons/:lessonId/exam/export.docx')
  @ApiOperation({ summary: '[teacher] The exam as an editable Word document' })
  async docx(
    @CurrentUser() user: JwtPayload,
    @CurrentAcademy() ctx: AcademyContext,
    @Param('lessonId') lessonId: string,
    @Res() res: Response,
  ) {
    const { filename, body } = await this.exports.docx(this.scope(user, ctx), lessonId);
    res.setHeader(
      'Content-Type',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    );
    res.setHeader('Content-Length', String(body.length));
    res.setHeader(
      'Content-Disposition',
      `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`,
    );
    res.end(body);
  }
}
