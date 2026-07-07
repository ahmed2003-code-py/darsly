import { Body, Controller, Delete, Get, Param, Patch, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { JwtPayload, Role } from '@darsly/shared-types';
import { IsBoolean, IsInt, IsOptional, IsString, MinLength } from 'class-validator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { Public } from '../common/decorators/public.decorator';
import { Roles } from '../common/decorators/roles.decorator';
import { AuditService } from '../audit/audit.service';
import { PrismaService } from '../prisma/prisma.service';

class UpsertSubjectDto {
  @IsString() @MinLength(2) nameAr: string;
  @IsString() @MinLength(2) nameEn: string;
  @IsOptional() @IsString() icon?: string;
  @IsOptional() @IsInt() sortOrder?: number;
  @IsOptional() @IsBoolean() isActive?: boolean;
}

class UpsertGradeDto {
  @IsString() @MinLength(2) nameAr: string;
  @IsString() @MinLength(2) nameEn: string;
  @IsString() @MinLength(2) code: string;
  @IsOptional() @IsInt() sortOrder?: number;
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

  @Public()
  @Get('subjects')
  @ApiOperation({ summary: 'List active subjects' })
  subjects() {
    return this.prisma.subject.findMany({
      where: { isActive: true },
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
