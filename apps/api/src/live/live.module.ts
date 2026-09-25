import { Module } from '@nestjs/common';
import { AcademyModule } from '../academy/academy.module';
import { AcademySiteModule } from '../academy-site/academy-site.module';
import { LiveProvidersModule } from './providers/live-providers.module';
import { LiveController } from './live.controller';
import { LiveEndWorker } from './live-end.worker';
import { LiveService } from './live.service';
import { LiveRtcController } from './rtc/live-rtc.controller';
import { LiveRtcService } from './rtc/live-rtc.service';
import { LiveRecordingService } from './recording/live-recording.service';
import { LiveRecorderWorker } from './recording/live-recorder.worker';
import { VideoModule } from '../video/video.module';

@Module({
  // AcademySiteModule for the AI job queue the summary runs on — the one this
  // project already has, rather than a second queue beside it.
  imports: [AcademyModule, AcademySiteModule, LiveProvidersModule, VideoModule],
  controllers: [LiveController, LiveRtcController],
  // LiveEndWorker: the server ends classes at their effective end.
  // LiveRtcService: the Cloudflare classroom's signalling and permissions.
  // LiveRecordingService/LiveRecorderWorker: Darsly's own recorder for
  // Cloudflare classes (the worker runs only with LIVE_RECORDER_ENABLED=true).
  providers: [LiveService, LiveEndWorker, LiveRtcService, LiveRecordingService, LiveRecorderWorker],
  // The gateway asks it who is allowed into a classroom's socket room.
  exports: [LiveService],
})
export class LiveModule {}
