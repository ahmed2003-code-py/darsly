import { Body, Controller, Get, HttpCode, Param, Patch, Post, Put } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { IsBoolean, IsIn, IsOptional } from 'class-validator';
import { JwtPayload } from '@darsly/shared-types';
import { AcademyContext, CurrentAcademy } from '../academy/academy-context';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { AcademyStaffFeature } from '../feature-flags/academy-staff-feature.decorator';
import { GroupChatService } from './group-chat.service';

class UpdateGroupChatDto {
  @IsOptional() @IsBoolean() enabled?: boolean;
  @IsOptional() @IsIn(['OPEN', 'ANNOUNCEMENTS']) mode?: 'OPEN' | 'ANNOUNCEMENTS';
}

class GroupModeDto {
  @IsIn(['OPEN', 'ANNOUNCEMENTS']) mode: 'OPEN' | 'ANNOUNCEMENTS';
}

/** Managing a group's chat from the group screen: group.manage, on a group that is yours. */
@ApiTags('teacher/groups')
@AcademyStaffFeature('group.manage', 'groups')
@Controller('teacher/groups/:groupId/chat')
export class GroupChatManageController {
  constructor(private readonly chats: GroupChatService) {}

  @Get()
  @ApiOperation({ summary: "[academy] This group's chat: on or off, and its mode" })
  status(@CurrentAcademy() ctx: AcademyContext, @Param('groupId') groupId: string) {
    return this.chats.status(ctx, groupId);
  }

  @Post()
  @HttpCode(200)
  @ApiOperation({
    summary: "[academy] Switch the group's chat on (one per group, however often pressed)",
  })
  enable(@CurrentAcademy() ctx: AcademyContext, @Param('groupId') groupId: string) {
    return this.chats.enable(ctx, groupId);
  }

  @Patch()
  @ApiOperation({
    summary: "[academy] Switch the group's chat off/on, or set Open / Announcements",
  })
  update(
    @CurrentAcademy() ctx: AcademyContext,
    @Param('groupId') groupId: string,
    @Body() dto: UpdateGroupChatDto,
  ) {
    return this.chats.update(ctx, groupId, dto);
  }
}

/** The group chat's info panel and mode switch, from inside the conversation. */
@ApiTags('chat')
@ApiBearerAuth()
@Controller('chat/threads/:id/group')
export class GroupChatController {
  constructor(private readonly chats: GroupChatService) {}

  @Get()
  @ApiOperation({ summary: 'Group chat info: name, staff, member count (students list for staff)' })
  info(@CurrentUser() user: JwtPayload, @Param('id') id: string) {
    return this.chats.info(user, id);
  }

  @Put('mode')
  @ApiOperation({ summary: '[group manager] Open or Announcements (staff write, students read)' })
  mode(@CurrentUser() user: JwtPayload, @Param('id') id: string, @Body() dto: GroupModeDto) {
    return this.chats.setModeFromChat(user, id, dto.mode);
  }
}
