import {
  ArrayMaxSize,
  IsArray,
  IsEmail,
  IsIn,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  MinLength,
} from 'class-validator';
import { EGY_PHONE_REGEX } from '../../auth/dto/auth.dto';

const THEME_ID = /^(preset|academy|cosmetic):[A-Za-z0-9_-]{1,64}$/;

export class CreateCenterDto {
  @IsString() @MinLength(2) @MaxLength(120) name: string;
  @IsOptional() @IsString() @MaxLength(120) slug?: string;
  @IsString() @MinLength(2) @MaxLength(120) adminName: string;
  @IsEmail() adminEmail: string;
  @IsOptional()
  @Matches(EGY_PHONE_REGEX, { message: 'Invalid Egyptian mobile number' })
  adminPhone?: string;
  /**
   * The looks this Center may choose from in its own Studio. Set here because
   * this is the screen where a Center's terms are decided — leaving it to a
   * later visit meant a new Center admin signed in to a Studio with an empty
   * shelf. Omitted or empty is valid: the Center then wears the platform
   * palette until an admin grants it something.
   */
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(200)
  @IsString({ each: true })
  @MaxLength(96, { each: true })
  @Matches(THEME_ID, { each: true, message: 'themeIds must be namespaced look ids' })
  themeIds?: string[];
}

export class SetCenterStatusDto {
  @IsIn(['ACTIVE', 'SUSPENDED', 'ARCHIVED']) status: 'ACTIVE' | 'SUSPENDED' | 'ARCHIVED';
}

/**
 * Deleting a Center takes its address back, typed out.
 *
 * The slug and not a boolean: this hides an organisation with its staff, its
 * groups and its attendance history behind one button, and a `{ confirm: true }`
 * is satisfied by a mis-click on the wrong row. Typing the address is the
 * standard shape for exactly this (it is what deleting a repository asks for)
 * and it is the only check that proves the admin knows *which* Center they are
 * looking at.
 */
export class DeleteCenterDto {
  @IsString() @MaxLength(120) confirmSlug: string;
}

export class RevokeCenterAccessDto {
  @IsString() @MaxLength(64) userId: string;
  /** Required only when revoking the Center's owner — see revokeAccess(). */
  @IsOptional() @IsString() @MaxLength(64) transferOwnershipTo?: string;
}
