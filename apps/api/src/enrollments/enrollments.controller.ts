import { Body, Controller, Get, HttpCode, Param, Patch, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { EnrollmentStatus, JwtPayload, Role } from '@darsly/shared-types';
import { IsEnum, IsOptional, IsString, MinLength } from 'class-validator';
import { AuditService } from '../audit/audit.service';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { Public } from '../common/decorators/public.decorator';
import { Roles } from '../common/decorators/roles.decorator';
import { EnrollmentsService } from './enrollments.service';

class EnrollDto {
  @IsString() @MinLength(1) courseId: string;
  @IsOptional() @IsString() couponCode?: string;
}

class QuoteDto extends EnrollDto {}

class ModerateDto {
  @IsOptional() @IsString() reason?: string;
}

class TeacherEnrollmentsQuery {
  @IsOptional() @IsEnum(EnrollmentStatus) status?: EnrollmentStatus;
}

@ApiTags('enrollments')
@Controller()
export class EnrollmentsController {
  constructor(
    private readonly enrollments: EnrollmentsService,
    private readonly audit: AuditService,
  ) {}

  // ── Student ──────────────────────────────────────────────────────────────

  @Public()
  @Post('enrollments/quote')
  @HttpCode(200)
  @ApiOperation({ summary: 'Price a course, optionally applying a coupon code' })
  quote(@Body() dto: QuoteDto) {
    return this.enrollments.quote(dto.courseId, dto.couponCode);
  }

  @Post('enrollments')
  @Roles(Role.STUDENT)
  @ApiBearerAuth()
  @ApiOperation({ summary: '[student] Enroll/subscribe (auto-approves or queues per course policy)' })
  async enroll(@CurrentUser() user: JwtPayload, @Body() dto: EnrollDto) {
    const enrollment = await this.enrollments.enroll(user.sub, dto.courseId, dto.couponCode);
    await this.audit.log({
      actorUserId: user.sub,
      action: 'enrollment.request',
      entity: 'Enrollment',
      entityId: enrollment.id,
      meta: { courseId: dto.courseId, status: enrollment.status },
    });
    return enrollment;
  }

  @Get('enrollments/mine')
  @Roles(Role.STUDENT)
  @ApiBearerAuth()
  @ApiOperation({ summary: '[student] My enrollments with course + teacher summary' })
  mine(@CurrentUser() user: JwtPayload) {
    return this.enrollments.myEnrollments(user.sub);
  }

  // ── Teacher approval queue ───────────────────────────────────────────────

  @Get('teacher/enrollments')
  @Roles(Role.TEACHER)
  @ApiBearerAuth()
  @ApiOperation({ summary: '[teacher] List enrollments in my tenant (filter by status)' })
  teacherList(@CurrentUser() user: JwtPayload, @Query() query: TeacherEnrollmentsQuery) {
    return this.enrollments.teacherList(user.tenantId!, query.status);
  }

  @Patch('teacher/enrollments/:id/approve')
  @Roles(Role.TEACHER)
  @ApiBearerAuth()
  @ApiOperation({ summary: '[teacher] Approve a pending enrollment' })
  async approve(@CurrentUser() user: JwtPayload, @Param('id') id: string) {
    const enrollment = await this.enrollments.approve(user.tenantId!, id);
    await this.audit.log({
      actorUserId: user.sub,
      action: 'enrollment.approve',
      entity: 'Enrollment',
      entityId: id,
    });
    return enrollment;
  }

  @Patch('teacher/enrollments/:id/reject')
  @Roles(Role.TEACHER)
  @ApiBearerAuth()
  @ApiOperation({ summary: '[teacher] Reject a pending enrollment' })
  async reject(
    @CurrentUser() user: JwtPayload,
    @Param('id') id: string,
    @Body() dto: ModerateDto,
  ) {
    const enrollment = await this.enrollments.reject(user.tenantId!, id, dto.reason);
    await this.audit.log({
      actorUserId: user.sub,
      action: 'enrollment.reject',
      entity: 'Enrollment',
      entityId: id,
      meta: { reason: dto.reason },
    });
    return enrollment;
  }

  @Patch('teacher/enrollments/:id/revoke')
  @Roles(Role.TEACHER)
  @ApiBearerAuth()
  @ApiOperation({ summary: '[teacher] Revoke an active enrollment (kill access)' })
  async revoke(
    @CurrentUser() user: JwtPayload,
    @Param('id') id: string,
    @Body() dto: ModerateDto,
  ) {
    const enrollment = await this.enrollments.revoke(user.tenantId!, id, dto.reason);
    await this.audit.log({
      actorUserId: user.sub,
      action: 'enrollment.revoke',
      entity: 'Enrollment',
      entityId: id,
      meta: { reason: dto.reason },
    });
    return enrollment;
  }
}
