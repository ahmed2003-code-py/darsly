import { Body, Controller, Delete, Get, Param, Patch, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { JwtPayload, Role } from '@darsly/shared-types';
import { IsBoolean, IsIn, IsInt, IsOptional, IsString, Max, MaxLength, Min, MinLength } from 'class-validator';
import { LIMITS } from '../common/validation';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { Public } from '../common/decorators/public.decorator';
import { Roles } from '../common/decorators/roles.decorator';
import { AuditService } from '../audit/audit.service';
import { PrismaService } from '../prisma/prisma.service';
import { SubjectTrack } from '@prisma/client';
import { viewerTrack } from './stage.util';
import { trackFilter } from './subject-track';

class UpsertSubjectDto {
  @IsString() @MinLength(2) @MaxLength(LIMITS.NAME) nameAr: string;
  @IsString() @MinLength(2) @MaxLength(LIMITS.NAME) nameEn: string;
  @IsOptional() @IsString() @MaxLength(60) icon?: string;
  @IsOptional() @IsInt() @Min(0) @Max(10_000) sortOrder?: number;
  @IsOptional() @IsBoolean() isActive?: boolean;
  @IsOptional() @IsIn(['GENERAL', 'LANGUAGES', 'BOTH']) track?: SubjectTrack;
}

class UpsertGradeDto {
  @IsString() @MinLength(2) @MaxLength(LIMITS.NAME) nameAr: string;
  @IsString() @MinLength(2) @MaxLength(LIMITS.NAME) nameEn: string;
  @IsString() @MinLength(2) @MaxLength(40) code: string;
  @IsOptional() @IsInt() @Min(0) @Max(10_000) sortOrder?: number;
  @IsOptional() @IsBoolean() isActive?: boolean;
}

/**
 * Subjects & grade levels. Public reads (discovery filters need them);
 * mutations are SUPER_ADMIN only — the platform owns the taxonomy.
 */
@ApiTags('catalog')
@Controller('catalog')
export class CatalogController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  /**
   * The subjects to offer, narrowed to the asker's school system.
   *
   * A signed-in student gets their own — that is the whole point of asking them
   * at sign-up — and `track=` is how the teacher's own picker and an admin
   * screen ask for a specific one. Everyone else gets the catalogue: a teacher
   * signing up has not said which systems they teach yet, and that question is
   * exactly what this list is for.
   */
  @Public()
  @Get('subjects')
  @ApiOperation({ summary: 'List active subjects (narrowed to the viewer’s school system)' })
  async subjects(@Query('track') asked?: string, @CurrentUser() viewer?: JwtPayload) {
    const wanted = asked === 'GENERAL' || asked === 'LANGUAGES' ? (asked as SubjectTrack) : null;
    const mine = wanted ?? (viewer?.sub ? await viewerTrack(this.prisma, viewer.sub) : null);
    const tracks = trackFilter(mine);
    return this.prisma.subject.findMany({
      where: { isActive: true, ...(tracks ? { track: { in: tracks } } : {}) },
      orderBy: { sortOrder: 'asc' },
    });
  }

  @Public()
  @Get('grades')
  @ApiOperation({ summary: 'List active grade levels' })
  grades() {
    return this.prisma.gradeLevel.findMany({
      where: { isActive: true },
      orderBy: { sortOrder: 'asc' },
    });
  }

  @Post('subjects')
  @Roles(Role.SUPER_ADMIN)
  @ApiBearerAuth()
  @ApiOperation({ summary: '[admin] Create subject' })
  async createSubject(@Body() dto: UpsertSubjectDto, @CurrentUser() user: JwtPayload) {
    const subject = await this.prisma.subject.create({ data: dto });
    await this.audit.log({
      actorUserId: user.sub,
      action: 'catalog.subject.create',
      entity: 'Subject',
      entityId: subject.id,
      meta: { nameAr: dto.nameAr },
    });
    return subject;
  }

  @Patch('subjects/:id')
  @Roles(Role.SUPER_ADMIN)
  @ApiBearerAuth()
  @ApiOperation({ summary: '[admin] Update subject' })
  async updateSubject(
    @Param('id') id: string,
    @Body() dto: UpsertSubjectDto,
    @CurrentUser() user: JwtPayload,
  ) {
    const subject = await this.prisma.subject.update({ where: { id }, data: dto });
    await this.audit.log({
      actorUserId: user.sub,
      action: 'catalog.subject.update',
      entity: 'Subject',
      entityId: id,
    });
    return subject;
  }

  @Delete('subjects/:id')
  @Roles(Role.SUPER_ADMIN)
  @ApiBearerAuth()
  @ApiOperation({ summary: '[admin] Deactivate subject (soft delete)' })
  async deleteSubject(@Param('id') id: string, @CurrentUser() user: JwtPayload) {
    const subject = await this.prisma.subject.update({
      where: { id },
      data: { isActive: false },
    });
    await this.audit.log({
      actorUserId: user.sub,
      action: 'catalog.subject.deactivate',
      entity: 'Subject',
      entityId: id,
    });
    return subject;
  }

  @Post('grades')
  @Roles(Role.SUPER_ADMIN)
  @ApiBearerAuth()
  @ApiOperation({ summary: '[admin] Create grade level' })
  async createGrade(@Body() dto: UpsertGradeDto, @CurrentUser() user: JwtPayload) {
    const grade = await this.prisma.gradeLevel.create({ data: dto });
    await this.audit.log({
      actorUserId: user.sub,
      action: 'catalog.grade.create',
      entity: 'GradeLevel',
      entityId: grade.id,
    });
    return grade;
  }

  @Patch('grades/:id')
  @Roles(Role.SUPER_ADMIN)
  @ApiBearerAuth()
  @ApiOperation({ summary: '[admin] Update grade level' })
  async updateGrade(
    @Param('id') id: string,
    @Body() dto: UpsertGradeDto,
    @CurrentUser() user: JwtPayload,
  ) {
    const grade = await this.prisma.gradeLevel.update({ where: { id }, data: dto });
    await this.audit.log({
      actorUserId: user.sub,
      action: 'catalog.grade.update',
      entity: 'GradeLevel',
      entityId: id,
    });
    return grade;
  }
}
