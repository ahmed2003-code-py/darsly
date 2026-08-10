import { ApiProperty } from '@nestjs/swagger';
import { IsString, MaxLength } from 'class-validator';

export class StartCheckoutDto {
  @ApiProperty({ description: 'The course being paid for.' })
  @IsString()
  @MaxLength(40)
  courseId!: string;
}
