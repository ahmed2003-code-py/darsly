import { Controller, Get, Query, Res } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Response } from 'express';
import { Public } from '../common/decorators/public.decorator';
import { ProofStorageService } from './proof-storage.service';

/**
 * Serves a proof-of-payment screenshot to whoever holds a valid signed URL.
 *
 * Public in the sense that no session is read — an `<img>` cannot send one.
 * Not public in any other sense: the key, the expiry and the signature all
 * have to agree, and the signature comes from the same secret that signs
 * playback, so a URL is worth exactly what it says for exactly as long as
 * it says.
 */
@ApiTags('files')
@Controller('files')
export class ProofFilesController {
  constructor(private readonly proofs: ProofStorageService) {}

  @Public()
  @Get('payment-proofs')
  @ApiOperation({ summary: 'A payment proof, by signed link' })
  async proof(
    @Query('k') k: string,
    @Query('e') e: string,
    @Query('t') t: string,
    @Res() res: Response,
  ) {
    const obj = await this.proofs.open(String(k ?? ''), Number(e), String(t ?? ''));
    res.setHeader('Content-Type', obj.contentType ?? 'image/jpeg');
    if (obj.contentLength) res.setHeader('Content-Length', String(obj.contentLength));
    res.setHeader('Cache-Control', 'private, max-age=600');
    obj.stream.pipe(res);
  }
}
