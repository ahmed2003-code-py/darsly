import { Body, Controller, Get, Param, Patch, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { JwtPayload, Role } from '@darsly/shared-types';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
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
import { IsOptionalId } from '../common/validation';
import { PrismaService } from '../prisma/prisma.service';
import { DiscoverTeachersQuery, TeachersService } from './teachers.service';

class DiscoverTeachersDto implements DiscoverTeachersQuery {
  @IsOptional() @IsString() @MaxLength(120) q?: string;
  @IsOptionalId() subjectId?: string;
  @IsOptionalId() gradeId?: string;
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
  @IsOptional() @IsUrl({ require_tld: false }) @MaxLength(500) introVideoUrl?: string;
  @IsOptional() @IsIn(['ar', 'en']) language?: string;
  @IsOptionalId() subjectId?: string;
  @IsOptional() @IsArray() @ArrayMaxSize(50) @ArrayUnique() @IsString({ each: true }) gradeIds?: string[];
  @IsOptional() @IsBoolean() autoApproveEnrollments?: boolean;
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
  profile(@Param('slug') slug: string) {
    return this.teachers.publicProfile(slug);
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
        subject: true,
        grades: { include: { grade: true } },
      },
    });
  }

  @Patch('teacher/profile')
  @Roles(Role.TEACHER)
  @ApiBearerAuth()
  @ApiOperation({ summary: '[teacher] Update my public profile (bio, intro video, subject, grades)' })
  async updateMyProfile(@Body() dto: UpdateMyTeacherProfileDto, @CurrentUser() user: JwtPayload) {
    const { gradeIds, ...fields } = dto;
    const profile = await this.prisma.teacherProfile.update({
      where: { id: user.tenantId },
      data: {
        ...fields,
        ...(gradeIds
          ? {
              grades: {
                deleteMany: {},
                create: gradeIds.map((gradeId) => ({ gradeId })),
              },
            }
          : {}),
      },
      include: { subject: true, grades: { include: { grade: true } } },
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
