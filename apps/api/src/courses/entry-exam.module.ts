import { Global, Module } from '@nestjs/common';
import { EntryExamService } from './entry-exam.service';

/**
 * Global because three separate gates have to agree about it: the course page,
 * the assessment gate and the playback gate. A rule that decides whether a
 * student may open a lesson has to answer the same way in all of them, and the
 * cheapest way to guarantee that is one instance everybody asks.
 */
@Global()
@Module({ providers: [EntryExamService], exports: [EntryExamService] })
export class EntryExamModule {}
