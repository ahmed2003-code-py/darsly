import { Body, Controller, Get, Put, UseGuards } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { AcademyContext, CurrentAcademy } from '../../academy/academy-context';
import { AcademyStaff } from '../../academy/academy-staff.decorator';
import { AiFeatureEnabledGuard } from '../ai-feature.guard';
import { AcademyFactsService } from './academy-facts.service';
import { SaveFactsDto } from './dto/save-facts.dto';

@ApiTags('academy-studio/facts')
@UseGuards(AiFeatureEnabledGuard)
@Controller('academy/facts')
export class AcademyFactsController {
  constructor(private readonly facts: AcademyFactsService) {}

  @Get()
  @AcademyStaff('academy.manage')
  @ApiOperation({ summary: '[staff] Get the academy profile facts (AI generation input)' })
  get(@CurrentAcademy() ctx: AcademyContext) {
    return this.facts.getOrCreate(ctx.academyId);
  }

  @Put()
  @AcademyStaff('academy.manage')
  @ApiOperation({ summary: '[staff] Save the academy profile facts' })
  save(@CurrentAcademy() ctx: AcademyContext, @Body() dto: SaveFactsDto) {
    return this.facts.save(ctx.academyId, dto);
  }
}
