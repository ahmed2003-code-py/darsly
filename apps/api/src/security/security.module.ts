import { Module } from '@nestjs/common';
import { AcademyModule } from '../academy/academy.module';
import { SecurityController } from './security.controller';

@Module({
  imports: [AcademyModule],
  controllers: [SecurityController],
})
export class SecurityModule {}
