import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Module,
  Patch,
  Post,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { IsIn, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';
import { JwtPayload } from '@darsly/shared-types';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { validateImageDataUrl } from '../common/image.util';
import { LIMITS } from '../common/validation';
import { STUDENT_TRACKS, type StudentTrackValue } from '../auth/dto/auth.dto';
import { PrismaService } from '../prisma/prisma.service';

// ~300 KB after decode is plenty for a client-resized 256² avatar.
const AVATAR_MAX_BYTES = 300 * 1024;

// The data-URL's mime and decoded size are checked by `validateImageDataUrl`
// below; this cap stops an oversized string from reaching the decoder at all.
class AvatarDto {
  @IsString() @MaxLength(LIMITS.IMAGE_DATA_URL) dataUrl: string;
}
class UpdateMeDto {
  @IsOptional() @IsString() @MinLength(2) @MaxLength(120) fullName?: string;
  /**
   * A student moves up a year and keeps the account: the same courses finished,
   * the same streak, the same teachers — pointed at the next year's catalogue.
   * Changing it is deliberately free of consequence; enrolments already bought
   * are not touched, because a course paid for in one year does not stop being
   * theirs in the next.
   */
  @IsOptional() @IsString() @MaxLength(LIMITS.ID) gradeId?: string;

  /**
   * Which school system they are in. Changeable for the same reason the year
   * is — students do move between them — and for the one the year does not
   * have: everybody who signed up before the question existed has no answer on
   * file, and this is where they give it.
   */
  @IsOptional() @IsIn(STUDENT_TRACKS) track?: StudentTrackValue;
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
      select: {
        id: true,
        fullName: true,
        email: true,
        phone: true,
        avatarUrl: true,
        role: true,
        createdAt: true,
        studentProfile: {
          select: {
            gradeId: true,
            track: true,
            grade: { select: { id: true, nameAr: true, nameEn: true, stage: true } },
          },
        },
      },
    });
    return user;
  }

  @Patch('profile')
  @ApiOperation({ summary: 'Update my display name, the year I am in, or my school system' })
  async update(@CurrentUser() u: JwtPayload, @Body() dto: UpdateMeDto) {
    if (dto.gradeId) {
      const grade = await this.prisma.gradeLevel.findFirst({
        where: { id: dto.gradeId, isActive: true },
      });
      if (!grade)
        throw new BadRequestException({
          message: 'Pick the year you are in',
          code: 'UNKNOWN_GRADE',
        });
      // Only a student has a year; anyone else asking for one is ignored rather
      // than refused, since nothing about their account changes either way.
      await this.prisma.studentProfile.updateMany({
        where: { userId: u.sub },
        data: { gradeId: dto.gradeId },
      });
    }
    if (dto.track) {
      await this.prisma.studentProfile.updateMany({
        where: { userId: u.sub },
        data: { track: dto.track },
      });
    }
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
