import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsDateString,
  IsIn,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
  ValidateNested,
} from 'class-validator';
import { IsId, LIMITS } from '../../common/validation';

const MAX_GROUP_BULK = 200;

export class CreateGroupDto {
  @IsString() @MinLength(2) @MaxLength(LIMITS.NAME) name: string;
  @IsOptional() @IsString() @MaxLength(LIMITS.NOTE) description?: string;
}

export class UpdateGroupDto {
  @IsOptional() @IsString() @MinLength(2) @MaxLength(LIMITS.NAME) name?: string;
  @IsOptional() @IsString() @MaxLength(LIMITS.NOTE) description?: string;
  @IsOptional() @IsIn(['ACTIVE', 'ARCHIVED']) status?: 'ACTIVE' | 'ARCHIVED';
}

export class AddGroupMembersDto {
  @IsArray() @ArrayMinSize(1) @ArrayMaxSize(MAX_GROUP_BULK)
  @IsString({ each: true }) @MaxLength(LIMITS.ID, { each: true })
  studentIds: string[];
}

export class AssignStaffDto {
  @IsId() userId: string;
  @IsIn(['TEACHER', 'ASSISTANT']) role: 'TEACHER' | 'ASSISTANT';
}

export class AttendanceRecordInput {
  @IsId() studentId: string;
  @IsIn(['PRESENT', 'ABSENT', 'LATE', 'EXCUSED']) status: 'PRESENT' | 'ABSENT' | 'LATE' | 'EXCUSED';
}

export class MarkAttendanceDto {
  @IsDateString({ strict: true }) date: string;
  @IsArray() @ArrayMinSize(1) @ArrayMaxSize(MAX_GROUP_BULK)
  @ValidateNested({ each: true }) @Type(() => AttendanceRecordInput)
  records: AttendanceRecordInput[];
}
