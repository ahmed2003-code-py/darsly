import { Body, Controller, Get, Param, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  IsBoolean,
  IsIn,
  IsInt,
  IsISO8601,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import { JwtPayload, Role } from '@darsly/shared-types';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { Roles } from '../common/decorators/roles.decorator';
import { PrismaService } from '../prisma/prisma.service';
import { CommercialTermsService } from './commercial-terms.service';

class NewTermsDto {
  @IsIn(['PERCENT', 'FIXED']) feeType: 'PERCENT' | 'FIXED';
  @IsOptional() @IsInt() @Min(0) @Max(10_000) feeBps?: number | null;
  @IsOptional() @IsInt() @Min(0) @Max(100_000_000) feeFixedCents?: number | null;
  @IsIn(['ADDITIVE', 'DEDUCTED']) feeMode: 'ADDITIVE' | 'DEDUCTED';
  @IsOptional() @IsBoolean() feeRefundableOnStudentCancel?: boolean;
  @IsOptional() @IsISO8601() effectiveFrom?: string;
  @IsOptional() @IsString() @MaxLength(500) note?: string;
}

/**
 * Darsly ↔ academy commercial terms (Live sales). Platform admin only: a
 * teacher or a Center can never reach these routes, so neither can change
 * Darsly's fee — they only ever see its effect on a price.
 */
@ApiTags('admin/commercial-terms')
@ApiBearerAuth()
@Roles(Role.SUPER_ADMIN)
@Controller('admin')
export class CommercialTermsController {
  constructor(
    private readonly terms: CommercialTermsService,
    private readonly prisma: PrismaService,
  ) {}

  @Get('commercial-terms/default')
  @ApiOperation({ summary: '[admin] Platform default commercial terms — history and current' })
  platform() {
    return this.terms.history(null);
  }

  @Post('commercial-terms/default')
  @ApiOperation({ summary: '[admin] New version of the platform default terms' })
  newPlatform(@CurrentUser() u: JwtPayload, @Body() dto: NewTermsDto) {
    return this.terms.createVersion(null, dto, u.sub);
  }

  @Get('academies/:id/commercial-terms')
  @ApiOperation({
    summary:
      '[admin] An academy’s commercial terms (history, effective) and its Center/teacher splits',
  })
  async forAcademy(@Param('id') id: string) {
    const [history, academy] = await Promise.all([
      this.terms.history(id),
      this.prisma.academy.findUnique({
        where: { id },
        select: {
          id: true,
          name: true,
          kind: true,
          teacherSharePercent: true,
          memberships: {
            where: { role: { in: ['OWNER', 'TEACHER'] }, status: 'ACTIVE' },
            select: {
              revenueSharePercent: true,
              role: true,
              user: { select: { id: true, fullName: true } },
            },
          },
        },
      }),
    ]);
    // What each teacher actually gets inside a Center: their own agreement,
    // else the Center's default, else nothing agreed (a paid sale is refused).
    const splits =
      academy?.kind === 'CENTER'
        ? academy.memberships.map((m) => ({
            userId: m.user.id,
            fullName: m.user.fullName,
            role: m.role,
            ownPercent: m.revenueSharePercent,
            effectivePercent: m.revenueSharePercent ?? academy.teacherSharePercent ?? null,
          }))
        : [];
    return {
      ...history,
      academy: academy
        ? {
            id: academy.id,
            name: academy.name,
            kind: academy.kind,
            teacherSharePercent: academy.teacherSharePercent,
          }
        : null,
      splits,
    };
  }

  @Post('academies/:id/commercial-terms')
  @ApiOperation({ summary: '[admin] New version of an academy’s commercial terms' })
  newForAcademy(@CurrentUser() u: JwtPayload, @Param('id') id: string, @Body() dto: NewTermsDto) {
    return this.terms.createVersion(id, dto, u.sub);
  }
}
