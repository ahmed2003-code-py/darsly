import { Body, Controller, Delete, Get, HttpCode, Param, Post, Req } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { JwtPayload } from '@darsly/shared-types';
import { Request } from 'express';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { Public } from '../common/decorators/public.decorator';
import { AuthService } from './auth.service';
import {
  ForgotPasswordDto,
  LoginDto,
  RefreshTokenDto,
  RegisterStudentDto,
  RegisterTeacherDto,
  ResetPasswordDto,
} from './dto/auth.dto';
import { TokenService } from './token.service';

function deviceContext(req: Request) {
  return {
    ip: req.ip,
    userAgent: req.headers['user-agent'],
  };
}

@ApiTags('auth')
@Controller('auth')
export class AuthController {
  constructor(
    private readonly authService: AuthService,
    private readonly tokenService: TokenService,
  ) {}

  @Public()
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Post('register/student')
  @HttpCode(201)
  @ApiOperation({ summary: 'Student self-signup (email + password) — auto-logs in' })
  registerStudent(@Body() dto: RegisterStudentDto, @Req() req: Request) {
    return this.authService.registerStudent(dto, deviceContext(req));
  }

  @Public()
  @Throttle({ default: { limit: 5, ttl: 600_000 } })
  @Post('register/teacher')
  @HttpCode(201)
  @ApiOperation({ summary: 'Teacher signup — lands PENDING admin approval' })
  registerTeacher(@Body() dto: RegisterTeacherDto) {
    return this.authService.registerTeacher(dto);
  }

  @Public()
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @Post('login')
  @HttpCode(200)
  @ApiOperation({ summary: 'Email + password login (students, teachers, admins)' })
  login(@Body() dto: LoginDto, @Req() req: Request) {
    return this.authService.login(dto, deviceContext(req));
  }

  @Public()
  @Throttle({ default: { limit: 5, ttl: 600_000 } })
  @Post('forgot-password')
  @HttpCode(200)
  @ApiOperation({ summary: 'Request a password-reset link (no email enumeration)' })
  forgotPassword(@Body() dto: ForgotPasswordDto) {
    return this.authService.forgotPassword(dto);
  }

  @Public()
  @Throttle({ default: { limit: 10, ttl: 600_000 } })
  @Post('reset-password')
  @HttpCode(200)
  @ApiOperation({ summary: 'Reset password with a valid token' })
  resetPassword(@Body() dto: ResetPasswordDto) {
    return this.authService.resetPassword(dto);
  }

  @Public()
  @Post('refresh')
  @HttpCode(200)
  @ApiOperation({ summary: 'Rotate refresh token (reuse detection revokes the session)' })
  refresh(@Body() dto: RefreshTokenDto) {
    return this.authService.refresh(dto.refreshToken);
  }

  @Post('logout')
  @HttpCode(200)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Revoke the current device session' })
  logout(@CurrentUser() user: JwtPayload) {
    return this.authService.logout(user.sessionId);
  }

  @Get('me')
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Current user profile (role-specific includes)' })
  me(@CurrentUser() user: JwtPayload) {
    return this.authService.me(user.sub);
  }

  @Get('sessions')
  @ApiBearerAuth()
  @ApiOperation({ summary: 'List my active device sessions' })
  sessions(@CurrentUser() user: JwtPayload) {
    return this.authService.listSessions(user.sub);
  }

  @Delete('sessions/:id')
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Revoke one of my device sessions' })
  async revokeSession(@CurrentUser() user: JwtPayload, @Param('id') id: string) {
    // Users may only revoke their own sessions.
    const sessions = await this.authService.listSessions(user.sub);
    if (sessions.some((s) => s.id === id)) {
      await this.tokenService.revokeSession(id, 'USER_REVOKED');
    }
    return { ok: true };
  }
}
