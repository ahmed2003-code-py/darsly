import { Body, Controller, Get, Param, Patch, Post } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { AcademyContext, CurrentAcademy } from '../academy/academy-context';
import { AcademyStaffFeature } from '../feature-flags/academy-staff-feature.decorator';
import { CreateRoomDto, UpdateRoomDto } from './dto/scheduling.dto';
import { RoomsService } from './rooms.service';

@ApiTags('teacher/rooms')
@AcademyStaffFeature('room.manage', 'scheduling')
@Controller('teacher/rooms')
export class RoomsController {
  constructor(private readonly rooms: RoomsService) {}

  @Get()
  @ApiOperation({ summary: '[academy owner] Physical rooms' })
  list(@CurrentAcademy() ctx: AcademyContext) {
    return this.rooms.list(ctx);
  }

  @Post()
  @ApiOperation({ summary: '[academy owner] Create a room' })
  create(@CurrentAcademy() ctx: AcademyContext, @Body() dto: CreateRoomDto) {
    return this.rooms.create(ctx, dto);
  }

  @Patch(':roomId')
  @ApiOperation({ summary: '[academy owner] Edit or archive/reactivate a room' })
  update(@CurrentAcademy() ctx: AcademyContext, @Param('roomId') roomId: string, @Body() dto: UpdateRoomDto) {
    return this.rooms.update(ctx, roomId, dto);
  }
}
