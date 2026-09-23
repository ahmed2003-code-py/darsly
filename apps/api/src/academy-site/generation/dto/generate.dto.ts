import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsOptional, IsString, MaxLength } from 'class-validator';
import { PALETTE_KEYS } from '../../pipeline/color-palettes';

export class GenerateSiteDto {
  @ApiPropertyOptional({
    enum: PALETTE_KEYS,
    description: 'The brand colour pair — the only design choice left.',
  })
  @IsOptional()
  @IsIn(PALETTE_KEYS)
  paletteKey?: string;

  @ApiPropertyOptional({
    enum: ['ar', 'en'],
    description: 'Default language of the generated page.',
  })
  @IsOptional()
  @IsIn(['ar', 'en'])
  lang?: 'ar' | 'en';
}

export class RegenerateSectionDto {
  @ApiProperty({ description: 'The id of the block/section to regenerate.' })
  @IsString()
  @MaxLength(60)
  sectionId!: string;
}
