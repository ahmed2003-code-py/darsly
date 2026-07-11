import { Body, Controller, Delete, Get, Module, Patch, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { IsOptional, IsString, MaxLength, MinLength } from 'class-validator';
import { JwtPayload } from '@darsly/shared-types';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { validateImageDataUrl } from '../common/image.util';
import { PrismaService } from '../prisma/prisma.service';

// ~300 KB after decode is plenty for a client-resized 256² avatar.
const AVATAR_MAX_BYTES = 300 * 1024;

class AvatarDto {
  @IsString() dataUrl: string;
}
class UpdateMeDto {
  @IsOptional() @IsString() @MinLength(2) @MaxLength(120) fullName?: string;
}

@ApiTags('profile')
@ApiBearerAuth()
@Controller('me')
class ProfileController {
  constructor(private readonly prisma: PrismaService) {}

  @Get('profile')
  @ApiOperation({ summary: 'My account profile (name, email, phone, avatar)' })
  async me(@CurrentUser() u: JwtPayload) {
    const user = await this.prisma.user.findUnique({
      where: { id: u.sub },
      select: { id: true, fullName: true, email: true, phone: true, avatarUrl: true, role: true, createdAt: true },
    });
    return user;
  }

  @Patch('profile')
  @ApiOperation({ summary: 'Update my display name' })
  async update(@CurrentUser() u: JwtPayload, @Body() dto: UpdateMeDto) {
    return this.prisma.user.update({
      where: { id: u.sub },
      data: { ...(dto.fullName ? { fullName: dto.fullName.trim() } : {}) },
      select: { id: true, fullName: true, avatarUrl: true },
    });
  }

  @Post('avatar')
  @ApiOperation({ summary: 'Set my avatar (client-resized base64 image)' })
  async setAvatar(@CurrentUser() u: JwtPayload, @Body() dto: AvatarDto) {
    validateImageDataUrl(dto.dataUrl, AVATAR_MAX_BYTES);
    const user = await this.prisma.user.update({
      where: { id: u.sub },
      data: { avatarUrl: dto.dataUrl },
      select: { avatarUrl: true },
    });
    return user;
  }

  @Delete('avatar')
  @ApiOperation({ summary: 'Remove my avatar' })
  async removeAvatar(@CurrentUser() u: JwtPayload) {
    await this.prisma.user.update({ where: { id: u.sub }, data: { avatarUrl: null } });
    return { ok: true };
  }
}

@Module({ controllers: [ProfileController] })
export class ProfileModule {}
