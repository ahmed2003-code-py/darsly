import { BadRequestException, Body, Controller, Get, Param, Patch, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { JwtPayload, Role } from '@darsly/shared-types';
import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayNotEmpty,
  ArrayUnique,
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUrl,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import { AuditService } from '../audit/audit.service';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { Public } from '../common/decorators/public.decorator';
import { Roles } from '../common/decorators/roles.decorator';
import { IsOptionalId, LIMITS } from '../common/validation';
import { EDUCATION_STAGES, type EducationStageValue } from '../auth/dto/auth.dto';
import { PrismaService } from '../prisma/prisma.service';
import { DiscoverTeachersQuery, TeachersService } from './teachers.service';

class DiscoverTeachersDto implements DiscoverTeachersQuery {
  @IsOptional() @IsString() @MaxLength(120) q?: string;
  @IsOptionalId() subjectId?: string;
  @IsOptionalId() gradeId?: string;
  /** Look outside my own year. Without it a signed-in student sees theirs. */
  @IsOptional() @Transform(({ value }) => value === true || value === 'true' || value === '1')
  allStages?: boolean;
  @IsOptional() @IsIn(['ar', 'en']) language?: string;
  @IsOptional() @Type(() => Number) @IsInt() @Min(0) priceMinCents?: number;
  @IsOptional() @Type(() => Number) @IsInt() @Min(0) priceMaxCents?: number;
  @IsOptional() @Type(() => Number) @Min(0) @Max(5) minRating?: number;
  @IsOptional() @IsIn(['rating', 'priceAsc', 'priceDesc', 'newest'])
  sort?: 'rating' | 'priceAsc' | 'priceDesc' | 'newest';
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(10_000) page?: number;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(50) pageSize?: number;
}

class UpdateMyTeacherProfileDto {
  @IsOptional() @IsString() @MaxLength(2_000) bio?: string;
  @IsOptional() @IsBoolean() acceptsStudentMessages?: boolean;
  @IsOptional() @IsUrl({ require_tld: false }) @MaxLength(500) introVideoUrl?: string;
  @IsOptional() @IsIn(['ar', 'en']) language?: string;
  /** The whole set, replaced — the list the teacher submitted is the list. */
  @IsOptional() @IsArray() @ArrayNotEmpty() @ArrayMaxSize(12) @ArrayUnique()
  @IsString({ each: true }) @MaxLength(LIMITS.ID, { each: true })
  subjectIds?: string[];
  @IsOptional() @IsArray() @ArrayMaxSize(4) @ArrayUnique() @IsIn(EDUCATION_STAGES, { each: true })
  stages?: EducationStageValue[];
}

@ApiTags('teachers')
@Controller()
export class TeachersController {
  constructor(
    private readonly teachers: TeachersService,
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  @Public()
  @Get('teachers')
  @ApiOperation({ summary: 'Discover teachers (search + filters: subject, grade, price, rating, language)' })
  // Public, but viewer-aware: a signed-in student does not see the teachers
  // competing with the one they already study that subject with.
  discover(@Query() query: DiscoverTeachersDto, @CurrentUser() viewer?: JwtPayload) {
    return this.teachers.discover(query, viewer?.sub);
  }

  @Public()
  @Get('teachers/:slug')
  @ApiOperation({ summary: 'Public teacher profile (bio, intro video, courses, reviews)' })
  // Public, but viewer-aware in the same way discovery is: signed in, the
  // listing narrows to the year that student is actually in.
  profile(@Param('slug') slug: string, @CurrentUser() viewer?: JwtPayload) {
    return this.teachers.publicProfile(slug, viewer?.sub);
  }

  @Get('teacher/profile')
  @Roles(Role.TEACHER)
  @ApiBearerAuth()
  @ApiOperation({ summary: '[teacher] My tenant profile' })
  myProfile(@CurrentUser() user: JwtPayload) {
    return this.prisma.teacherProfile.findUniqueOrThrow({
      where: { id: user.tenantId },
      include: {
        user: { select: { fullName: true, avatarUrl: true, email: true, phone: true } },
        subjects: { include: { subject: true } },
      },
    });
  }

  @Patch('teacher/profile')
  @Roles(Role.TEACHER)
  @ApiBearerAuth()
  @ApiOperation({ summary: '[teacher] Update my public profile (bio, intro video, subject, stages)' })
  async updateMyProfile(@Body() dto: UpdateMyTeacherProfileDto, @CurrentUser() user: JwtPayload) {
    // Narrowing the stages leaves existing courses aimed where they were: a
    // course already sold to a stage is not un-sold by a later edit to the
    // profile, and pulling it out from under its students would be worse than
    // the inconsistency.
    const { subjectIds, ...rest } = dto;
    if (subjectIds?.length) {
      const live = await this.prisma.subject.count({
        where: { id: { in: subjectIds }, isActive: true },
      });
      if (live !== subjectIds.length) {
        throw new BadRequestException({ message: 'Pick the subjects you teach', code: 'UNKNOWN_SUBJECT' });
      }
    }
    const profile = await this.prisma.teacherProfile.update({
      where: { id: user.tenantId },
      data: {
        ...rest,
        // Courses already sold keep the subject they were created with, for the
        // same reason narrowing the stages leaves them alone.
        ...(subjectIds
          ? { subjects: { deleteMany: {}, create: subjectIds.map((subjectId) => ({ subjectId })) } }
          : {}),
      },
      include: { subjects: { include: { subject: true } } },
    });
    await this.audit.log({
      actorUserId: user.sub,
      action: 'teacher.profile.update',
      entity: 'TeacherProfile',
      entityId: user.tenantId,
    });
    return profile;
  }
}
