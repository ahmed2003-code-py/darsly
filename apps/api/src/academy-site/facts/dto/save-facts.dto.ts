import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsOptional,
  IsString,
  IsUrl,
  MaxLength,
  ValidateNested,
} from 'class-validator';

export class SocialLinkDto {
  @ApiProperty({ example: 'youtube' })
  @IsString()
  @MaxLength(30)
  platform!: string;

  @ApiProperty({ example: 'https://youtube.com/@teacher' })
  @IsUrl({ require_protocol: true })
  @MaxLength(300)
  url!: string;
}

/**
 * Structured "facts" a teacher provides; the AI generates page copy from these.
 * All fields optional so the teacher can save progressively. Caps keep payloads
 * bounded and the generated page sane.
 */
export class SaveFactsDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(120)
  fullName?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  bio?: string;

  @ApiPropertyOptional({ type: [String] })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(12)
  @IsString({ each: true })
  @MaxLength(60, { each: true })
  subjects?: string[];

  @ApiPropertyOptional({ type: [String] })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(12)
  @IsString({ each: true })
  @MaxLength(60, { each: true })
  stages?: string[];

  @ApiPropertyOptional({ type: [String] })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(20)
  @IsString({ each: true })
  @MaxLength(200, { each: true })
  achievements?: string[];

  @ApiPropertyOptional({ type: [SocialLinkDto] })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(10)
  @ValidateNested({ each: true })
  @Type(() => SocialLinkDto)
  socials?: SocialLinkDto[];

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(20000)
  rawIntake?: string;
}
