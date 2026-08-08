import {
  IsBoolean, IsEmail, IsIn, IsInt, IsOptional, IsString, Matches, Max, MaxLength, Min, MinLength,
} from 'class-validator';

const HEX = /^#[0-9a-fA-F]{6}$/;

export class UpdateAcademyDto {
  @IsOptional() @IsString() @MaxLength(80) name?: string;
  @IsOptional() @IsString() @MaxLength(160) tagline?: string;
  /**
   * The academy's public address: darsly.app/a/<slug>. Auto-generated on signup
   * (ae0011w), which is fine for a system and useless on a business card — a
   * teacher sharing their site wants their own name in it.
   *
   * Lower-case letters, digits and single hyphens; 3–40 characters. Uniqueness
   * and a reserved-word list are enforced in the service.
   */
  @IsOptional()
  @IsString()
  @Matches(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, {
    message: 'slug may contain lower-case letters, digits and single hyphens only',
  })
  @MinLength(3)
  @MaxLength(40)
  slug?: string;

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
