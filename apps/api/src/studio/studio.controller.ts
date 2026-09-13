import { Body, Controller, Delete, Get, HttpCode, Param, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CosmeticCategory } from '@prisma/client';
import { JwtPayload, Role } from '@darsly/shared-types';
import { IsIn, IsString, Matches, MaxLength } from 'class-validator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { Roles } from '../common/decorators/roles.decorator';
import { StudioService } from './studio.service';

const CATEGORIES: CosmeticCategory[] = [
  'THEME', 'ACCENT', 'BUTTON_STYLE', 'CARD_STYLE', 'NAV_STYLE', 'AVATAR', 'FRAME', 'EFFECT',
];

class KeyDto {
  @IsString() @MaxLength(64) @Matches(/^[a-z0-9-]+$/) key: string;
}

class CategoryDto {
  @IsIn(CATEGORIES) category: CosmeticCategory;
}

class AccentDto {
  @IsString() @Matches(/^#[0-9a-fA-F]{6}$/, { message: 'accent must be a six-digit hex colour' })
  hex: string;
}

/**
 * Student Studio.
 *
 * Every route derives the student from the token. There is no `studentId` on
 * any request here and no endpoint that takes one, which is the simplest form
 * of the guarantee that one student cannot read or spend another's.
 *
 * Prices are never accepted from the caller either: the request names an item
 * by key and the server looks up what it costs.
 */
@ApiTags('student-studio')
@ApiBearerAuth()
@Roles(Role.STUDENT)
@Controller('student/studio')
export class StudioController {
  constructor(private readonly studio: StudioService) {}

  @Get()
  @ApiOperation({ summary: '[student] Studio: catalogue, collection, balance, worn set' })
  async overview(@CurrentUser() user: JwtPayload) {
    // Anything an achievement has earned since the last visit is handed over
    // here, so the collection is right before it is drawn.
    await this.studio.syncEarned(user.sub).catch(() => undefined);
    return this.studio.overview(user.sub);
  }

  @Get('theme')
  @ApiOperation({ summary: '[student] Just the tokens, for the app shell on load' })
  theme(@CurrentUser() user: JwtPayload) {
    return this.studio.theme(user.sub);
  }

  @Post('unlock')
  @HttpCode(200)
  @ApiOperation({ summary: '[student] Unlock a cosmetic with coins' })
  unlock(@CurrentUser() user: JwtPayload, @Body() dto: KeyDto) {
    return this.studio.unlock(user.sub, dto.key);
  }

  @Post('equip')
  @HttpCode(200)
  @ApiOperation({ summary: '[student] Wear an owned cosmetic' })
  equip(@CurrentUser() user: JwtPayload, @Body() dto: KeyDto) {
    return this.studio.equip(user.sub, dto.key);
  }

  @Post('unequip')
  @HttpCode(200)
  @ApiOperation({ summary: '[student] Take one slot back to the default' })
  unequip(@CurrentUser() user: JwtPayload, @Body() dto: CategoryDto) {
    return this.studio.unequip(user.sub, dto.category);
  }

  @Post('accent')
  @HttpCode(200)
  @ApiOperation({ summary: '[student] Use a colour of my own; safe variants are derived' })
  accent(@CurrentUser() user: JwtPayload, @Body() dto: AccentDto) {
    return this.studio.setAccent(user.sub, dto.hex);
  }

  @Delete('customization')
  @ApiOperation({ summary: '[student] Reset what I am wearing — never what I own' })
  reset(@CurrentUser() user: JwtPayload) {
    return this.studio.reset(user.sub);
  }
}
