import { Controller, Get, Param, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { AcademyStatus, Role } from '@darsly/shared-types';
import { Roles } from '../common/decorators/roles.decorator';
import { AdminAcademiesService } from './admin-academies.service';

const STATUS_VALUES = new Set<string>(Object.values(AcademyStatus));

@ApiTags('admin/academies')
@ApiBearerAuth()
@Roles(Role.SUPER_ADMIN)
@Controller('admin/academies')
export class AdminAcademiesController {
  constructor(private readonly academies: AdminAcademiesService) {}

  @Get()
  @ApiOperation({ summary: '[admin] Academies — search, filter, paginate' })
  list(
    @Query('search') search?: string,
    @Query('status') status?: string,
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
  ) {
    return this.academies.listAcademies({
      search,
      status: status && STATUS_VALUES.has(status) ? (status as AcademyStatus) : undefined,
      page: page ? Number(page) : undefined,
      pageSize: pageSize ? Number(pageSize) : undefined,
    });
  }

  @Get(':id')
  @ApiOperation({ summary: '[admin] Academy drill-down: identity, staff, counts, revenue, feature flags' })
  detail(@Param('id') id: string) {
    return this.academies.academyDetail(id);
  }
}
