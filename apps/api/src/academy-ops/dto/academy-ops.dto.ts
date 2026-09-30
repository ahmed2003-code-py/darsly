import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsDateString,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateIf,
  ValidateNested,
} from 'class-validator';
import { IsId, LIMITS } from '../../common/validation';

const MAX_GROUP_BULK = 200;

/**
 * A physical class's configuration (Center Operations C2). Every field is
 * optional and nullable: `null` clears it, absent leaves it. Seats and grace
 * are bounded here and again by CHECK constraints in the database.
 */
class GroupClassConfig {
  @IsOptional() @ValidateIf((_, v) => v !== null) @IsId() subjectId?: string | null;
  @IsOptional() @ValidateIf((_, v) => v !== null) @IsId() gradeId?: string | null;
  @IsOptional() @ValidateIf((_, v) => v !== null) @IsInt() @Min(1) @Max(1000) capacity?:
    number | null;
  @IsOptional() @ValidateIf((_, v) => v !== null) @IsInt() @Min(0) @Max(120) lateGraceMin?:
    number | null;
}

export class CreateGroupDto extends GroupClassConfig {
  @IsString() @MinLength(2) @MaxLength(LIMITS.NAME) name: string;
  @IsOptional() @IsString() @MaxLength(LIMITS.NOTE) description?: string;
}

export class UpdateGroupDto extends GroupClassConfig {
  @IsOptional() @IsString() @MinLength(2) @MaxLength(LIMITS.NAME) name?: string;
  @IsOptional() @IsString() @MaxLength(LIMITS.NOTE) description?: string;
  @IsOptional() @IsIn(['ACTIVE', 'ARCHIVED']) status?: 'ACTIVE' | 'ARCHIVED';
}

export class TransferMemberDto {
  @IsId() toGroupId: string;
}

export class AddGroupMembersDto {
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(MAX_GROUP_BULK)
  @IsString({ each: true })
  @MaxLength(LIMITS.ID, { each: true })
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
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(MAX_GROUP_BULK)
  @ValidateNested({ each: true })
  @Type(() => AttendanceRecordInput)
  records: AttendanceRecordInput[];
}
