import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsOptional } from 'class-validator';

export const VIBES = ['academic', 'premium', 'energetic', 'trusted'] as const;

export class GenerateSiteDto {
  @ApiPropertyOptional({ enum: VIBES })
  @IsOptional()
  @IsIn(VIBES)
  vibe?: (typeof VIBES)[number];
}
