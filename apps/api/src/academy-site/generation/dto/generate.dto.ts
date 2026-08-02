import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsOptional, IsString, MaxLength } from 'class-validator';

export const VIBES = ['academic', 'premium', 'energetic', 'trusted'] as const;

export class GenerateSiteDto {
  @ApiPropertyOptional({ enum: VIBES })
  @IsOptional()
  @IsIn(VIBES)
  vibe?: (typeof VIBES)[number];

  @ApiPropertyOptional({ description: 'Free-text brief describing the desired look and colors.' })
  @IsOptional()
  @IsString()
  @MaxLength(600)
  stylePrompt?: string;

  @ApiPropertyOptional({ enum: ['ar', 'en'], description: 'Default language of the generated page.' })
  @IsOptional()
  @IsIn(['ar', 'en'])
  lang?: 'ar' | 'en';
}
