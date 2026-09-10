import { ApiProperty } from '@nestjs/swagger';
import { AcademyMediaKind } from '@prisma/client';
import { IsIn } from 'class-validator';

export const UPLOADABLE_KINDS: AcademyMediaKind[] = ['LOGO', 'COVER', 'GALLERY', 'AVATAR', 'PROMO'];

export class UploadMediaDto {
  @ApiProperty({ enum: UPLOADABLE_KINDS })
  @IsIn(UPLOADABLE_KINDS, { message: 'kind must be one of LOGO, COVER, GALLERY, AVATAR, PROMO' })
  kind!: AcademyMediaKind;
}
