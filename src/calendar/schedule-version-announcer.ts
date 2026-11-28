import { Injectable, Logger } from '@nestjs/common';
import type { AuthenticatedUser } from '../auth/interfaces/authenticated-user.interface';
import { requireSchoolId } from '../common/utils/request-context';
import { PrismaService } from '../database/prisma.service';
import { RealtimeService } from '../realtime/realtime.service';

/**
 * Säger till personalrummet att grundschemat har bytts ut (E9, g465 L-4): en återställning av en version ersätter varje lektion, och en kollega som har
 * tidtabellen öppen fick ingenting, fast dokumentet sa att klienten läser om året. Händelsen nämner inga lektioner (de har fått nya id), så klienten läser året.
 *
 * Ligger för sig och inte i ScheduleVersionsService, som snapshot, återställning och Generera delar. Anropas av vägen EFTER att återställningen har gjorts:
 * en återställning som misslyckas säger till ingen, och ett fel här sänker aldrig en återställning som redan står.
 */
@Injectable()
export class ScheduleVersionAnnouncer {
  private readonly logger = new Logger(ScheduleVersionAnnouncer.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly realtime: RealtimeService,
  ) {}

  /**
   * Grundschemat byttes ut. I utkastläget är grundschemat utkastet och bara administratörerna får veta (som varje skrivare av det gör), annars alla som läser
   * det. Läget läses i en egen transaktion efter återställningen; kan det inte läsas sägs det till alla, och en klient som får veta för mycket läser året och
   * finner det den hade.
   */
  async restored(user: AuthenticatedUser): Promise<void> {
    const schoolId = requireSchoolId(user);
    let draft = false;
    try {
      const settings = await this.prisma.queryWithRls(user, (db) => db.publicationSettings.findUnique({ where: { schoolId }, select: { publishMode: true } }));
      draft = settings?.publishMode === 'DRAFT';
    } catch (error) {
      this.logger.warn(`The publish mode was not read to tell the staff room of a restore [school=${schoolId}]: ${error instanceof Error ? error.message : String(error)}`);
    }
    this.realtime.notifyMasterTimetableChanged(schoolId, draft ? { draft: true } : {});
  }
}
