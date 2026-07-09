import { Module } from '@nestjs/common';
import { VideoModule } from '../video/video.module';
import { NotesController } from './notes.controller';
import { PlaybackController } from './playback.controller';
import { PlaybackService } from './playback.service';
import { SignedUrlService } from './signed-url.service';

@Module({
  imports: [VideoModule],
  controllers: [PlaybackController, NotesController],
  providers: [PlaybackService, SignedUrlService],
  exports: [PlaybackService],
})
export class PlaybackModule {}
