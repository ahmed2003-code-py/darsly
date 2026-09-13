import { Module } from '@nestjs/common';
import { GamificationModule } from '../gamification/gamification.module';
import { StudioController } from './studio.controller';
import { StudioService } from './studio.service';

/** Student Studio. Leans entirely on the existing gamification economy — no
 *  second XP system, no second currency, no second ledger. */
@Module({
  imports: [GamificationModule],
  controllers: [StudioController],
  providers: [StudioService],
  exports: [StudioService],
})
export class StudioModule {}
