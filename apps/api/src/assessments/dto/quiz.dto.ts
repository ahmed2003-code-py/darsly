import {
  IsArray,
  IsBoolean,
  IsInt,
  IsObject,
  IsOptional,
  IsString,
  Max,
  Min,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';
import { QuestionType } from '@darsly/shared-types';

export class UpsertQuizDto {
  @IsOptional() @IsInt() @Min(0) @Max(100) passingScore?: number;
  @IsOptional() @IsInt() @Min(0) timeLimitSec?: number | null;
  @IsOptional() @IsBoolean() shuffleQuestions?: boolean;
  @IsOptional() @IsInt() @Min(1) @Max(50) maxAttempts?: number | null;
}

export class QuizOptionDto {
  @IsString() id: string;
  @IsString() text: string;
}

export class QuizQuestionDto {
  @IsOptional() @IsString() type?: QuestionType;
  @IsString() prompt: string;
  @IsOptional() @IsArray() @ValidateNested({ each: true }) @Type(() => QuizOptionDto)
  options?: QuizOptionDto[];
  @IsOptional() @IsString() correctOptionId?: string | null;
  @IsOptional() @IsString() explanation?: string;
  @IsOptional() @IsInt() @Min(1) points?: number;
}

export class SetQuizQuestionsDto {
  @IsArray() @ValidateNested({ each: true }) @Type(() => QuizQuestionDto)
  questions: QuizQuestionDto[];
}

export class SubmitAttemptDto {
  // { [questionId]: optionId | freeText }
  @IsObject() answers: Record<string, string>;
}

export class GradeAttemptDto {
  // Manual points awarded per short-answer question: { [questionId]: points }
  @IsObject() scores: Record<string, number>;
}
