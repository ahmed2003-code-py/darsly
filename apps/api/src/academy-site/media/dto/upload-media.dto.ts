import { ApiProperty } from '@nestjs/swagger';
import { AcademyMediaKind } from '@prisma/client';
import { IsIn } from 'class-validator';

// Image kinds accepted this slice (PROMO video is handled by a later slice).
export const UPLOADABLE_KINDS: AcademyMediaKind[] = ['LOGO', 'COVER', 'GALLERY', 'AVATAR'];

export class UploadMediaDto {
  @ApiProperty({ enum: UPLOADABLE_KINDS })
  @IsIn(UPLOADABLE_KINDS, { message: 'kind must be one of LOGO, COVER, GALLERY, AVATAR' })
  kind!: AcademyMediaKind;
}
