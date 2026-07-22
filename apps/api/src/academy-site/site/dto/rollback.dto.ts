import { ApiProperty } from '@nestjs/swagger';
import { IsString, Length } from 'class-validator';

export class RollbackDto {
  @ApiProperty()
  @IsString()
  @Length(1, 40)
  snapshotId!: string;
}
