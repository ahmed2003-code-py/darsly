import { Body, Controller, Delete, Get, Param, Patch, Post, Query } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { AcademyContext, CurrentAcademy } from '../academy/academy-context';
import { AcademyStaffFeature } from '../feature-flags/academy-staff-feature.decorator';
import {
  AddGroupMembersDto,
  AssignStaffDto,
  CreateGroupDto,
  UpdateGroupDto,
} from './dto/academy-ops.dto';
import { GroupsService } from './groups.service';

@ApiTags('teacher/groups')
@AcademyStaffFeature('group.manage', 'groups')
@Controller('teacher/groups')
export class GroupsController {
  constructor(private readonly groups: GroupsService) {}

  @Get()
  @ApiOperation({
    summary: '[academy] Groups — OWNER sees all, staff sees only their assigned groups',
  })
  list(
    @CurrentAcademy() ctx: AcademyContext,
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
  ) {
    return this.groups.list(ctx, {
      page: page ? Number(page) : undefined,
      pageSize: pageSize ? Number(pageSize) : undefined,
    });
  }

  @Post()
  @ApiOperation({ summary: '[academy] Create a group' })
  create(@CurrentAcademy() ctx: AcademyContext, @Body() dto: CreateGroupDto) {
    return this.groups.create(ctx, dto);
  }

  @Get(':groupId')
  @ApiOperation({ summary: '[academy] Group detail — members + staff assignments' })
  detail(@CurrentAcademy() ctx: AcademyContext, @Param('groupId') groupId: string) {
    return this.groups.detail(ctx, groupId);
  }

  @Patch(':groupId')
  @ApiOperation({ summary: '[academy] Edit or archive a group' })
  update(
    @CurrentAcademy() ctx: AcademyContext,
    @Param('groupId') groupId: string,
    @Body() dto: UpdateGroupDto,
  ) {
    return this.groups.update(ctx, groupId, dto);
  }

  @Post(':groupId/members')
  @ApiOperation({ summary: '[academy] Add one or more students to a group' })
  addMembers(
    @CurrentAcademy() ctx: AcademyContext,
    @Param('groupId') groupId: string,
    @Body() dto: AddGroupMembersDto,
  ) {
    return this.groups.addMembers(ctx, groupId, dto);
  }

  @Delete(':groupId/members/:studentId')
  @ApiOperation({ summary: '[academy] Remove a student from a group' })
  removeMember(
    @CurrentAcademy() ctx: AcademyContext,
    @Param('groupId') groupId: string,
    @Param('studentId') studentId: string,
  ) {
    return this.groups.removeMember(ctx, groupId, studentId);
  }

  @Post(':groupId/assignments')
  @ApiOperation({ summary: '[academy owner] Assign a teacher/assistant to a group' })
  assignStaff(
    @CurrentAcademy() ctx: AcademyContext,
    @Param('groupId') groupId: string,
    @Body() dto: AssignStaffDto,
  ) {
    return this.groups.assignStaff(ctx, groupId, dto);
  }

  @Delete(':groupId/assignments/:userId')
  @ApiOperation({ summary: '[academy owner] Remove a staff assignment from a group' })
  unassignStaff(
    @CurrentAcademy() ctx: AcademyContext,
    @Param('groupId') groupId: string,
    @Param('userId') userId: string,
  ) {
    return this.groups.unassignStaff(ctx, groupId, userId);
  }
}
