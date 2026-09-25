import {
  Body,
  Controller,
  Delete,
  Get,
  HttpException,
  HttpStatus,
  Param,
  Post,
  Put,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { SkipThrottle } from '@nestjs/throttler';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsIn,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  ValidateNested,
} from 'class-validator';
import { JwtPayload, Role } from '@darsly/shared-types';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { Roles } from '../../common/decorators/roles.decorator';
import { LIMITS } from '../../common/validation';
import { LiveRtcService } from './live-rtc.service';

/** An SDP is a few KB; a hundred tracks' worth is still well under this. */
const SDP_MAX = 128 * 1024;

class SdpDto {
  @IsString() @MaxLength(SDP_MAX) sdp: string;
  @IsIn(['offer', 'answer']) type: 'offer' | 'answer';
}

class OpenConnectionDto {
  @IsIn(['RECEIVE', 'SEND']) purpose: 'RECEIVE' | 'SEND';
}

class PublishTrackDto {
  @IsString() @MaxLength(16) @Matches(/^[0-9a-zA-Z_-]+$/) mid: string;
  @IsIn(['AUDIO', 'VIDEO', 'SCREEN', 'SCREEN_AUDIO']) kind:
    'AUDIO' | 'VIDEO' | 'SCREEN' | 'SCREEN_AUDIO';
}

class PublishDto {
  @ValidateNested() @Type(() => SdpDto) offer: SdpDto;
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(4)
  @ValidateNested({ each: true })
  @Type(() => PublishTrackDto)
  tracks: PublishTrackDto[];
}

class SubscribeDto {
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(64)
  @IsString({ each: true })
  @MaxLength(LIMITS.ID, { each: true })
  trackIds: string[];
  /** A simulcast layer, when the publisher sends several. */
  @IsOptional() @IsString() @MaxLength(8) @Matches(/^[a-z0-9]+$/) preferredRid?: string;
}

class RenegotiateDto {
  @ValidateNested() @Type(() => SdpDto) answer: SdpDto;
}

class CloseTracksDto {
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(64)
  @IsString({ each: true })
  @MaxLength(16, { each: true })
  mids: string[];
  @IsOptional() @ValidateNested() @Type(() => SdpDto) offer?: SdpDto;
}

class HandDto {
  @IsIn(['raise', 'lower']) action: 'raise' | 'lower';
}

class HandDecisionDto {
  @IsIn(['approve', 'reject', 'revoke']) action: 'approve' | 'reject' | 'revoke';
}

/**
 * Per person, not per address: the global limiter counts by IP, and a school
 * lab is thirty students behind one. Joining a class is a handful of calls; a
 * page gone wrong is hundreds — this lets the first through and stops the
 * second. Per replica, which is enough to bound one browser.
 */
const RATE_WINDOW_MS = 10_000;
const RATE_MAX = 60;
const hits = new Map<string, { n: number; until: number }>();
function limit(userId: string) {
  const now = Date.now();
  const h = hits.get(userId);
  if (!h || h.until <= now) {
    if (hits.size > 10_000) hits.clear();
    hits.set(userId, { n: 1, until: now + RATE_WINDOW_MS });
    return;
  }
  if (++h.n > RATE_MAX) {
    throw new HttpException(
      { message: 'Too many requests', code: 'RTC_RATE_LIMITED' },
      HttpStatus.TOO_MANY_REQUESTS,
    );
  }
}

/**
 * The Cloudflare classroom's signalling: every WebRTC push and pull goes
 * through here, is checked against the class, and only then reaches the SFU
 * with the server's credentials. The browser never holds a provider secret.
 */
@ApiTags('live')
@ApiBearerAuth()
@SkipThrottle()
@Controller()
export class LiveRtcController {
  constructor(private readonly rtc: LiveRtcService) {}

  @Get('live/:id/rtc/state')
  @Roles(Role.STUDENT, Role.TEACHER)
  @ApiOperation({ summary: 'Who is in the classroom, what is published, who may speak' })
  state(@CurrentUser() u: JwtPayload, @Param('id') id: string) {
    limit(u.sub);
    return this.rtc.state(u.sub, id);
  }

  @Post('live/:id/rtc/connections')
  @Roles(Role.STUDENT, Role.TEACHER)
  @ApiOperation({ summary: 'Open a WebRTC connection to the classroom' })
  open(@CurrentUser() u: JwtPayload, @Param('id') id: string, @Body() dto: OpenConnectionDto) {
    limit(u.sub);
    return this.rtc.openConnection(u.sub, id, dto.purpose);
  }

  @Post('live/:id/rtc/connections/:cid/publish')
  @Roles(Role.STUDENT, Role.TEACHER)
  @ApiOperation({ summary: 'Send tracks (checked against what this person may send)' })
  publish(
    @CurrentUser() u: JwtPayload,
    @Param('id') id: string,
    @Param('cid') cid: string,
    @Body() dto: PublishDto,
  ) {
    limit(u.sub);
    return this.rtc.publish(u.sub, id, cid, dto);
  }

  @Post('live/:id/rtc/connections/:cid/subscribe')
  @Roles(Role.STUDENT, Role.TEACHER)
  @ApiOperation({ summary: 'Receive published tracks' })
  subscribe(
    @CurrentUser() u: JwtPayload,
    @Param('id') id: string,
    @Param('cid') cid: string,
    @Body() dto: SubscribeDto,
  ) {
    limit(u.sub);
    return this.rtc.subscribe(u.sub, id, cid, dto);
  }

  @Put('live/:id/rtc/connections/:cid/renegotiate')
  @Roles(Role.STUDENT, Role.TEACHER)
  renegotiate(
    @CurrentUser() u: JwtPayload,
    @Param('id') id: string,
    @Param('cid') cid: string,
    @Body() dto: RenegotiateDto,
  ) {
    limit(u.sub);
    return this.rtc.renegotiate(u.sub, id, cid, dto.answer);
  }

  @Post('live/:id/rtc/connections/:cid/close-tracks')
  @Roles(Role.STUDENT, Role.TEACHER)
  closeTracks(
    @CurrentUser() u: JwtPayload,
    @Param('id') id: string,
    @Param('cid') cid: string,
    @Body() dto: CloseTracksDto,
  ) {
    limit(u.sub);
    return this.rtc.closeTracks(u.sub, id, cid, dto);
  }

  @Delete('live/:id/rtc/connections/:cid')
  @Roles(Role.STUDENT, Role.TEACHER)
  close(@CurrentUser() u: JwtPayload, @Param('id') id: string, @Param('cid') cid: string) {
    limit(u.sub);
    return this.rtc.closeConnection(u.sub, id, cid);
  }

  @Post('live/:id/hand')
  @Roles(Role.STUDENT, Role.TEACHER)
  @ApiOperation({ summary: 'Raise or lower your hand' })
  hand(@CurrentUser() u: JwtPayload, @Param('id') id: string, @Body() dto: HandDto) {
    limit(u.sub);
    return this.rtc.hand(u.sub, id, dto.action);
  }

  @Post('live/:id/hand/:userId')
  @Roles(Role.STUDENT, Role.TEACHER)
  @ApiOperation({ summary: "The teacher approves, rejects or revokes a student's hand" })
  decide(
    @CurrentUser() u: JwtPayload,
    @Param('id') id: string,
    @Param('userId') userId: string,
    @Body() dto: HandDecisionDto,
  ) {
    limit(u.sub);
    return this.rtc.hand(u.sub, id, dto.action, userId);
  }

  @Post('live/:id/rtc/remove/:userId')
  @Roles(Role.STUDENT, Role.TEACHER)
  @ApiOperation({ summary: 'The teacher removes someone from the classroom' })
  remove(@CurrentUser() u: JwtPayload, @Param('id') id: string, @Param('userId') userId: string) {
    limit(u.sub);
    return this.rtc.remove(u.sub, id, userId);
  }
}
