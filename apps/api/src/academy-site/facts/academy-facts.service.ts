import { Injectable } from '@nestjs/common';
import { AcademyProfileFacts, Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { SaveFactsDto } from './dto/save-facts.dto';

@Injectable()
export class AcademyFactsService {
  constructor(private readonly prisma: PrismaService) {}

  /** Return the academy's facts, lazily creating an empty row on first access. */
  async getOrCreate(academyId: string): Promise<AcademyProfileFacts> {
    const existing = await this.prisma.academyProfileFacts.findUnique({ where: { academyId } });
    if (existing) return existing;
    return this.prisma.academyProfileFacts.create({ data: { academyId } });
  }

  /** Upsert the provided fields. Omitted keys are left unchanged. */
  async save(academyId: string, dto: SaveFactsDto): Promise<AcademyProfileFacts> {
    const data: Prisma.AcademyProfileFactsUncheckedCreateInput = { academyId };
    if (dto.fullName !== undefined) data.fullName = dto.fullName;
    if (dto.bio !== undefined) data.bio = dto.bio;
    if (dto.subjects !== undefined) data.subjects = dto.subjects;
    if (dto.stages !== undefined) data.stages = dto.stages;
    if (dto.achievements !== undefined) data.achievements = dto.achievements;
    if (dto.socials !== undefined) data.socials = dto.socials as unknown as Prisma.InputJsonValue;
    if (dto.rawIntake !== undefined) data.rawIntake = dto.rawIntake;

    const { academyId: _omit, ...update } = data;
    return this.prisma.academyProfileFacts.upsert({
      where: { academyId },
      create: data,
      update,
    });
  }
}
