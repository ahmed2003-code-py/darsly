import { Module } from '@nestjs/common';
import { AcademyModule } from '../academy/academy.module';
import { ChatModule } from '../chat/chat.module';
import { StaffController } from './staff.controller';
import { StaffService } from './staff.service';

/** Phase 1: the assistant's workspace (courses, students, progress). */
@Module({
  imports: [AcademyModule, ChatModule],
  controllers: [StaffController],
  providers: [StaffService],
  exports: [StaffService],
})
export class StaffModule {}
