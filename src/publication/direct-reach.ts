import { ConflictException } from '@nestjs/common';
import { Prisma, type PrismaClient } from '@prisma/client';
import type { PublishMode } from './publish-mode';

/**
 * FRÅGAN FÖRE EN ÄNDRING I DIREKT SOM NÅR FAMILJER (P5, beslut 8).
 *
 * Direkt är förvalet. I Direkt flyttar en ändring av grundschemat de publicerade lektionerna i kalendern på en gång, och eleverna i
 * lektionen och deras vårdnadshavare får en notis (master-lessons.service, SCHEDULE_CHANGED). Beslut 8 behåller Direkt men låter
 * sidan fråga före den första ändringen som når familjer i en publicerad period, och säga vem som får notisen. Den här filen är
 * frågans server: vad som är "en publicerad period", om skolan har svarat, och vakten som skrivvägarna anropar.
 *
 * VAD SOM ÄR EN PUBLICERAD PERIOD. Skolans senaste publicering av läsåret som ännu gäller: utfall PUBLISHED, inte en REFILL (systemets
 * egen kopia av en äldre) och med validTo i dag (skolans dag) eller senare. Ett läsår utan en sådan publicering har ingen familj som
 * kan nås, och ingen fråga ställs.
 *
 * ETT SVAR, EN GÅNG. Svaret är skolans (PublicationSettings.directReachAcknowledgedAt, migrering 20270312090000) och ges en gång: det
 * gäller tills skolan byter läge, åt vilket håll det än är (DraftService.switchMode skriver null), för ett byte är ett nytt beslut om
 * vem som nås. Det gäller också en nyare publicering: en skola som har valt att stå kvar i Direkt har valt det.
 *
 * VARFÖR EN DEFINER-FUNKTION. Inställningen och publiceringarna är Publicerings områdesarmar. Varje profil som flyttar en lektion skriver i dag
 * också Publicering (PROFILE_WRITES), men vakten ska inte hänga på det: en arm som döljer raderna ger noll rader, och en vakt som läser noll rader
 * tiger där den ska fråga. Vakten läser därför app.direct_reach_facts, som svarar för den inloggades egen skola och ger en rad.
 *
 * VAKTEN. requireDirectReachAnswered anropas av en skrivväg EFTER att den har flyttat de publicerade lektionerna, inuti sin
 * transaktion, med antalet lektioner den nådde. Den kastar när skolan är i Direkt, ändringen nådde minst en lektion och frågan inte är
 * besvarad; kastet rullar tillbaka skrivningen, så ingenting har ändrats och ingen notis har gått. En ändring som inte nådde någon
 * (en anteckning, en lektion utanför perioden, propagate: false) frågar aldrig.
 *
 * Skrivvägar som anropar vakten i dag: PATCH master-lessons/:id, PATCH master-lessons/block-card, DELETE master-lessons/:id, POST swaps/apply
 * (ett byte flyttar publicerade lektioner på samma sätt och rullas tillbaka med sin säkerhetsversion) och POST placement-write-in (E4b: förläggningarna skrivs in,
 * och de lektioner de ersätter tas bort ur kalendern).
 * E4:s läggning går genom PATCHens skrivning och frågar där: en parkerad lektion som läggs tillbaka flyttar sina kalenderrader som ett drag (updateIn), och en ny
 * lektion (createIn) når ingen förrän kalendern nästa gång genereras. En skrivväg som lämnar den skrivningen måste själv anropa funktionen med det antal den nådde.
 */

/** The problem `code` of a change in Direkt that reached families before the school had answered. */
export const DIRECT_REACH_UNANSWERED = 'DIRECT_REACH_UNANSWERED';

/** What app.direct_reach_facts answers, with the dates as 'YYYY-MM-DD'. */
export interface DirectReachFacts {
  publishedAt: Date;
  validFrom: string;
  validTo: string;
  acknowledgedAt: Date | null;
  /** The school has answered (acknowledgedAt is not null). */
  answered: boolean;
}

const asDay = (value: Date): string => value.toISOString().slice(0, 10);

/** The school's latest valid publication of the year and its answer, or null when no publication of the year still holds. */
export async function readDirectReachFacts(tx: PrismaClient, academicYearId: string): Promise<DirectReachFacts | null> {
  const rows = await tx.$queryRaw<
    Array<{ publishedAt: Date; validFrom: Date; validTo: Date; acknowledgedAt: Date | null; answered: boolean }>
  >(Prisma.sql`SELECT * FROM app.direct_reach_facts(${academicYearId}::uuid)`);
  const row = rows?.[0];
  if (!row) return null;
  return {
    publishedAt: row.publishedAt,
    validFrom: asDay(row.validFrom),
    validTo: asDay(row.validTo),
    acknowledgedAt: row.acknowledgedAt,
    answered: row.answered === true,
  };
}

/** The question is asked: the school is in Direkt, a publication of the year still holds, and the answer is not at or after it. */
export function mustAsk(mode: PublishMode, facts: DirectReachFacts | null): boolean {
  return mode === 'DIRECT' && facts !== null && !facts.answered;
}

export function directReachUnanswered(facts: Pick<DirectReachFacts, 'validFrom' | 'validTo'>): ConflictException {
  return new ConflictException({
    message:
      'Ändringen når elever och vårdnadshavare i en publicerad period. Svara på frågan om att fortsätta i Direkt eller använda utkast, så görs ändringen.',
    code: DIRECT_REACH_UNANSWERED,
    params: { validFrom: facts.validFrom, validTo: facts.validTo },
  });
}

/**
 * The guard of a write that moves or removes published lessons. Asked AFTER the write has propagated, inside its transaction, with the
 * number of published lessons it reached (moved plus removed): the throw rolls the whole write back.
 */
export async function requireDirectReachAnswered(
  tx: PrismaClient,
  input: { academicYearId: string; mode: PublishMode; reached: number },
): Promise<void> {
  if (input.mode !== 'DIRECT' || input.reached <= 0) return;
  const facts = await readDirectReachFacts(tx, input.academicYearId);
  if (facts !== null && mustAsk(input.mode, facts)) throw directReachUnanswered(facts);
}
