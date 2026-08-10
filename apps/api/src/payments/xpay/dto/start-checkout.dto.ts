import { ApiProperty } from '@nestjs/swagger';
import { IsOptional, IsString, MaxLength } from 'class-validator';

export class StartCheckoutDto {
  @ApiProperty({ description: 'The course being paid for.' })
  @IsString()
  @MaxLength(40)
  courseId!: string;

  @ApiProperty({
    required: false,
    description: 'Optional discount code, priced identically to the bank-transfer route.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(40)
  couponCode?: string;
}
