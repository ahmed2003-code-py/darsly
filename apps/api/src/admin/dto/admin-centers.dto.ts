import { IsEmail, IsIn, IsOptional, IsString, Matches, MaxLength, MinLength } from 'class-validator';
import { EGY_PHONE_REGEX } from '../../auth/dto/auth.dto';

export class CreateCenterDto {
  @IsString() @MinLength(2) @MaxLength(120) name: string;
  @IsOptional() @IsString() @MaxLength(120) slug?: string;
  @IsString() @MinLength(2) @MaxLength(120) adminName: string;
  @IsEmail() adminEmail: string;
  @IsOptional() @Matches(EGY_PHONE_REGEX, { message: 'Invalid Egyptian mobile number' }) adminPhone?: string;
}

export class SetCenterStatusDto {
  @IsIn(['ACTIVE', 'SUSPENDED', 'ARCHIVED']) status: 'ACTIVE' | 'SUSPENDED' | 'ARCHIVED';
}
