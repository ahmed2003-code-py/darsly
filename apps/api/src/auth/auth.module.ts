import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { AcademyModule } from '../academy/academy.module';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { OtpService } from './otp.service';
import { TokenService } from './token.service';

@Module({
  // AcademyModule for InvitationLinksService: a Center invitation can create
  // the account it is for, and the claim has to sit inside that registration.
  imports: [JwtModule.register({ global: true }), AcademyModule],
  controllers: [AuthController],
  providers: [AuthService, OtpService, TokenService],
  exports: [TokenService, OtpService],
})
export class AuthModule {}
