import { IsInt, IsOptional, IsString, Min } from 'class-validator';

export class UpsertAssignmentDto {
  @IsString() prompt: string;
  @IsOptional() @IsString() dueAt?: string | null;
  @IsOptional() @IsInt() @Min(1) maxScore?: number;
}

export class SubmitAssignmentDto {
  @IsOptional() @IsString() body?: string;
  @IsOptional() @IsString() fileKey?: string | null;
}

export class GradeSubmissionDto {
  @IsInt() @Min(0) score: number;
  @IsOptional() @IsString() feedback?: string;
}
