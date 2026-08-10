import { Global, Module } from '@nestjs/common';
import { MailService } from './mail.service';

/** Global so auth, admin and future flows can inject MailService directly. */
@Global()
@Module({
  providers: [MailService],
  exports: [MailService],
})
export class MailModule {}
