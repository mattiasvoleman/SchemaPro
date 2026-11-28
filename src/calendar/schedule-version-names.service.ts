import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import type { AuthenticatedUser } from '../auth/interfaces/authenticated-user.interface';
import { PrismaService } from '../database/prisma.service';
import type { ScheduleVersionSummary } from './schedule-versions.service';

/**
 * Namnet på en version (E9: döp om). En version är en ögonblicksbild, och bara namnet kan ändras: lektionerna i den är det de var. Ligger för sig själv och
 * inte i ScheduleVersionsService, som snapshot, återställning och Generera delar med varandra; det här rör ingen lektion, inget lås och ingen publicering, så
 * ingen skrivning av grundschemat väntar på det och det väntar inte på någon.
 */
@Injectable()
export class ScheduleVersionNamesService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Byter namn på en version. Namnet trimmas, och ett namn som bara är blanksteg är 400 (DTO:n tar `MinLength(1)` för ett sådant). En version i en annan skola
   * syns inte för RLS och är 404, som för varje annan väg.
   */
  async rename(versionId: string, name: string, user: AuthenticatedUser): Promise<ScheduleVersionSummary> {
    const trimmed = name.trim();
    if (trimmed.length === 0) throw new BadRequestException('name: a version needs a name.');
    // Postgres text holds no NUL: it comes back from the database as a 500 ("an unexpected database error"), for a value the sender chose.
    if (trimmed.includes('\u0000')) throw new BadRequestException('name: a version name has no NUL character.');
    return this.prisma.withRls(user, async (tx) => {
      const found = await tx.scheduleVersion.findUnique({ where: { id: versionId }, select: { id: true } });
      if (!found) throw new NotFoundException('Schedule version not found.');
      const version = await tx.scheduleVersion.update({
        where: { id: versionId },
        data: { name: trimmed },
        select: { id: true, academicYearId: true, name: true, lessonCount: true, createdAt: true },
      });
      return { ...version, createdAt: version.createdAt.toISOString() };
    });
  }
}
