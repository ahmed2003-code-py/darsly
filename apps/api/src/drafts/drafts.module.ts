import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { AcademyModule } from '../academy/academy.module';
import { DraftsController } from './drafts.controller';
import { DraftsService } from './drafts.service';

/** Autosaved work in progress. Depends on nothing but the database and the
 *  academy guards — a draft is a row and a scope, and keeping it that small is
 *  what lets any form in the app use it without a new endpoint each time. */
@Module({
  imports: [PrismaModule, AcademyModule],
  controllers: [DraftsController],
  providers: [DraftsService],
  exports: [DraftsService],
})
export class DraftsModule {}
