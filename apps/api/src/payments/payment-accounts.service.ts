import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

export interface UpsertAccountDto {
  method: 'INSTAPAY' | 'VODAFONE_CASH' | 'BANK_TRANSFER' | 'OTHER';
  label: string;
  handle: string;
  instructions?: string;
  isActive?: boolean;
  sortOrder?: number;
}

@Injectable()
export class PaymentAccountsService {
  constructor(private readonly prisma: PrismaService) {}

  /** Active accounts students transfer money to. */
  listPublic() {
    return this.prisma.platformPaymentAccount.findMany({
      where: { isActive: true },
      orderBy: { sortOrder: 'asc' },
      select: { id: true, method: true, label: true, handle: true, instructions: true },
    });
  }

  listAll() {
    return this.prisma.platformPaymentAccount.findMany({ orderBy: { sortOrder: 'asc' } });
  }

  create(dto: UpsertAccountDto) {
    return this.prisma.platformPaymentAccount.create({
      data: {
        method: dto.method as any,
        label: dto.label.trim(),
        handle: dto.handle.trim(),
        instructions: dto.instructions ?? '',
        isActive: dto.isActive ?? true,
        sortOrder: dto.sortOrder ?? 0,
      },
    });
  }

  async update(id: string, dto: Partial<UpsertAccountDto>) {
    await this.assert(id);
    return this.prisma.platformPaymentAccount.update({
      where: { id },
      data: {
        ...(dto.method ? { method: dto.method as any } : {}),
        ...(dto.label != null ? { label: dto.label.trim() } : {}),
        ...(dto.handle != null ? { handle: dto.handle.trim() } : {}),
        ...(dto.instructions != null ? { instructions: dto.instructions } : {}),
        ...(dto.isActive != null ? { isActive: dto.isActive } : {}),
        ...(dto.sortOrder != null ? { sortOrder: dto.sortOrder } : {}),
      },
    });
  }

  async remove(id: string) {
    await this.assert(id);
    await this.prisma.platformPaymentAccount.delete({ where: { id } });
    return { id, deleted: true };
  }

  private async assert(id: string) {
    const a = await this.prisma.platformPaymentAccount.findUnique({ where: { id } });
    if (!a) throw new NotFoundException('Payment account not found');
  }
}
