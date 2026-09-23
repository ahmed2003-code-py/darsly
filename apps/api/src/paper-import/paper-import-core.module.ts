import { Module } from '@nestjs/common';
import { PagePreparerService } from './page-preparer.service';
import { PaperImportConfig } from './paper-import.config';

/**
 * The half of paper import that the AI worker needs and the API does not own.
 *
 * It exists to keep the module graph acyclic. `AcademySiteModule` has to
 * provide the PAPER_IMPORT job handler — that is where the handler registry
 * lives, and it is how `LiveSummaryHandler` is wired too — while
 * `PaperImportModule` (the controllers) has to import `AcademySiteModule` for
 * the queue. Anything both sides need therefore lives here, in a module that
 * imports nothing at all.
 */
@Module({
  providers: [PaperImportConfig, PagePreparerService],
  exports: [PaperImportConfig, PagePreparerService],
})
export class PaperImportCoreModule {}
