import { Controller, Get } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { AcademyContext, CurrentAcademy } from '../academy/academy-context';
import { AcademyStaff } from '../academy/academy-staff.decorator';
import { NeedsAttentionService } from './needs-attention.service';

@ApiTags('teacher/needs-attention')
@AcademyStaff('student.manage')
@Controller('teacher/needs-attention')
export class NeedsAttentionController {
  constructor(private readonly needsAttention: NeedsAttentionService) {}

  @Get()
  @ApiOperation({
    summary:
      '[academy] Rule-based operational view: repeated absences, inactive students, stale groups',
  })
  overview(@CurrentAcademy() ctx: AcademyContext) {
    return this.needsAttention.overview(ctx);
  }
}
