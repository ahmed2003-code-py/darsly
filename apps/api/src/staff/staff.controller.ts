import { Controller, Get, Param, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { AcademyContext, CurrentAcademy } from '../academy/academy-context';
import { AcademyStaff } from '../academy/academy-staff.decorator';
import { AcademyMembershipGuard } from '../academy/guards/academy-membership.guard';
import { StaffScopeService } from '../academy/staff-scope.service';
import { StaffService } from './staff.service';

/**
 * The staff workspace — what an assistant opens after signing in. The
 * academy comes from X-Academy-Id (resolved and membership-checked by the
 * guard); the courses and students from StaffScopeService. A course or
 * student outside the member's scope is a 404, whether it is asked for by
 * the page or typed into a URL.
 */
@ApiTags('staff')
@ApiBearerAuth()
@Controller('staff')
export class StaffController {
  constructor(
    private readonly staff: StaffService,
    private readonly scopes: StaffScopeService,
  ) {}

  @Get('me')
  @UseGuards(AcademyMembershipGuard)
  @ApiOperation({ summary: '[staff] My title, access and courses in this academy' })
  async me(@CurrentAcademy() ctx: AcademyContext) {
    return this.staff.me(await this.scopes.forContext(ctx));
  }

  @Get('courses')
  @UseGuards(AcademyMembershipGuard)
  @ApiOperation({ summary: '[staff] The courses I work on' })
  async courses(@CurrentAcademy() ctx: AcademyContext) {
    return this.staff.courses(await this.scopes.forContext(ctx));
  }

  @Get('students')
  @AcademyStaff('student.view')
  @ApiOperation({ summary: '[staff] Students of my courses' })
  async students(
    @CurrentAcademy() ctx: AcademyContext,
    @Query('courseId') courseId?: string,
    @Query('q') search?: string,
    @Query('cursor') cursor?: string,
  ) {
    return this.staff.students(await this.scopes.forContext(ctx), { courseId, search, cursor });
  }

  @Get('students/:studentId')
  @AcademyStaff('student.view')
  @ApiOperation({ summary: '[staff] One student of my courses' })
  async student(@CurrentAcademy() ctx: AcademyContext, @Param('studentId') studentId: string) {
    return this.staff.student(await this.scopes.forContext(ctx), studentId);
  }

  @Get('students/:studentId/progress')
  @AcademyStaff('progress.view')
  @ApiOperation({ summary: "[staff] A student's progress in my courses" })
  async progress(@CurrentAcademy() ctx: AcademyContext, @Param('studentId') studentId: string) {
    return this.staff.progress(await this.scopes.forContext(ctx), studentId);
  }

  @Get('payments')
  @AcademyStaff('payment.view')
  @ApiOperation({ summary: '[staff] Payments for my courses (read only)' })
  async payments(@CurrentAcademy() ctx: AcademyContext, @Query('status') status?: string) {
    const allowed = ['PENDING', 'PAID', 'REJECTED', 'FAILED', 'REFUNDED'];
    return this.staff.payments(
      await this.scopes.forContext(ctx),
      status && allowed.includes(status) ? status : undefined,
    );
  }
}
