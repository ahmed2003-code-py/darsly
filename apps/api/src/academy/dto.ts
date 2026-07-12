import {
  IsBoolean, IsEmail, IsIn, IsInt, IsOptional, IsString, Matches, Max, MaxLength, Min,
} from 'class-validator';

const HEX = /^#[0-9a-fA-F]{6}$/;

export class UpdateAcademyDto {
  @IsOptional() @IsString() @MaxLength(80) name?: string;
  @IsOptional() @IsString() @MaxLength(160) tagline?: string;
  @IsOptional() @IsString() logoUrl?: string; // data URL or https
  @IsOptional() @IsString() coverUrl?: string;
  @IsOptional() @IsString() @Matches(HEX, { message: 'colorPrimary must be a #RRGGBB hex' }) colorPrimary?: string;
  @IsOptional() @IsString() @Matches(HEX, { message: 'colorAccent must be a #RRGGBB hex' }) colorAccent?: string;
  @IsOptional() @IsIn(['ar', 'en']) language?: string;
  @IsOptional() @IsBoolean() requiresEnrollmentApproval?: boolean;
  @IsOptional() @IsInt() @Min(1) @Max(10) maxConcurrentSessions?: number;
}

export class AddMemberDto {
  @IsEmail() email: string;
  @IsIn(['TEACHER', 'ASSISTANT']) role: 'TEACHER' | 'ASSISTANT';
}

export class UpdateMemberDto {
  @IsOptional() @IsIn(['TEACHER', 'ASSISTANT']) role?: 'TEACHER' | 'ASSISTANT';
  @IsOptional() @IsIn(['ACTIVE', 'SUSPENDED']) status?: 'ACTIVE' | 'SUSPENDED';
}
