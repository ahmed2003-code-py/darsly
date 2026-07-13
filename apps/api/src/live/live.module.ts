import { Module } from '@nestjs/common';
import { AcademyModule } from '../academy/academy.module';
import { LiveController } from './live.controller';
import { LiveService } from './live.service';

@Module({
  imports: [AcademyModule],
  controllers: [LiveController],
  providers: [LiveService],
})
export class LiveModule {}
