import { Body, Controller, Get, Param, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { IsInt, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';
import { JwtPayload, Role } from '@darsly/shared-types';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { Roles } from '../common/decorators/roles.decorator';
import { ReviewsService } from './reviews.service';

class UpsertReviewDto {
  @IsString() courseId: string;
  @IsInt() @Min(1) @Max(5) rating: number;
  @IsOptional() @IsString() @MaxLength(1000) comment?: string;
}

@ApiTags('reviews')
@ApiBearerAuth()
@Roles(Role.STUDENT)
@Controller('reviews')
export class ReviewsController {
  constructor(private readonly reviews: ReviewsService) {}

  @Post()
  @ApiOperation({ summary: '[student] Write/update my review of a course' })
  upsert(@CurrentUser() u: JwtPayload, @Body() dto: UpsertReviewDto) {
    return this.reviews.upsert(u.sub, dto);
  }

  @Get('mine/:courseId')
  @ApiOperation({ summary: '[student] My existing review of a course (or null)' })
  mine(@CurrentUser() u: JwtPayload, @Param('courseId') courseId: string) {
    return this.reviews.mineForCourse(u.sub, courseId);
  }
}
