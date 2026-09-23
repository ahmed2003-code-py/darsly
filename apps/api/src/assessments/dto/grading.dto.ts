import {
  ArrayMaxSize,
  ArrayNotEmpty,
  IsArray,
  IsOptional,
  IsString,
  MaxLength,
} from 'class-validator';

/** The options that count as right, after a teacher corrects a key. */
export class FixKeyDto {
  @IsArray()
  @ArrayNotEmpty()
  @ArrayMaxSize(10)
  @IsString({ each: true })
  @MaxLength(64, { each: true })
  correctOptionIds: string[];
}

/** A student saying a question is wrong, and why they think so. */
export class ReportQuestionDto {
  @IsOptional() @IsString() @MaxLength(500) note?: string;
}
