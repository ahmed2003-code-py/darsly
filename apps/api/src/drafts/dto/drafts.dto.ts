import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsEnum, IsObject, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';

/** The kinds a form may declare. Mirrors the Prisma enum; an incoming value
 *  outside it is a 400, not a row. */
export enum ContentDraftKindDto {
  LESSON = 'LESSON',
  ASSIGNMENT = 'ASSIGNMENT',
  QUIZ = 'QUIZ',
  COURSE = 'COURSE',
}

/**
 * An autosave.
 *
 * `data` is deliberately unvalidated beyond "it is an object": the shape is
 * the screen's, it changes whenever the screen does, and a DTO that described
 * it would reject a teacher's half-typed lesson every time a field was added.
 * The size ceiling is enforced in the service, where the serialised bytes are
 * known.
 *
 * Note that the global pipe runs with `forbidNonWhitelisted`, so every field a
 * caller may send has to be declared here — an undeclared one is a 400 with a
 * message nobody can act on, which this codebase has already shipped once.
 */
export class SaveDraftBodyDto {
  @ApiProperty({ enum: ContentDraftKindDto })
  @IsEnum(ContentDraftKindDto)
  kind!: ContentDraftKindDto;

  @ApiProperty({ description: 'Stable identity of the form, e.g. `lesson:abc123`' })
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  scopeKey!: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(60)
  courseId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(60)
  lessonId?: string;

  @ApiPropertyOptional({ description: 'What to call this on the drafts list' })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  label?: string;

  @ApiPropertyOptional({ description: 'Which step the teacher had reached' })
  @IsOptional()
  @IsString()
  @MaxLength(60)
  step?: string;

  @ApiProperty({ type: Object, description: "The form's own state" })
  @IsObject()
  data!: Record<string, unknown>;
}
