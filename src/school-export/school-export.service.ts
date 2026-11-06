import { createHash } from 'node:crypto';
import { ConflictException, ForbiddenException, GoneException, HttpException, HttpStatus, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma, type SchoolExportStatus } from '@prisma/client';
import { recordRead, type AccessKind } from '../access-log/access-log';
import { profileDecides } from '../auth/admin-areas';
import type { AuthenticatedUser } from '../auth/interfaces/authenticated-user.interface';
import { PrismaService } from '../database/prisma.service';
import type { FileSummary, HeldOutSummary, ReadAbout } from './school-export';

/** Orders a school may place a day: a file is a copy of everything, and each one is stored for three days. */
export const MAX_ORDERS_PER_DAY = 3;
/** Pieces read per transaction when a file is sent. */
const PIECES_PER_READ = 8;

export interface SchoolExportView {
  id: string;
  status: SchoolExportStatus;
  requestedAt: Date;
  startedAt: Date | null;
  finishedAt: Date | null;
  expiresAt: Date | null;
  byteSize: number | null;
  sha256: string | null;
  files: FileSummary[] | null;
  heldOut: HeldOutSummary | null;
  errorClass: string | null;
  requestedBy: { id: string; name: string } | null;
  /** True while the file can be fetched: READY and not past its time. */
  fetchable: boolean;
}

export interface OpenedFile {
  id: string;
  filename: string;
  byteSize: number;
  sha256: string;
  chunkCount: number;
  /** The file's bytes in order, a few pieces at a time, each read in a transaction of its own. */
  pieces(): AsyncGenerator<Buffer>;
}

/** The reasons the gateway answers by name. */
export const SCHOOL_EXPORT_CODES = {
  decides: 'SCHOOL_EXPORT_DECIDES',
  inHand: 'SCHOOL_EXPORT_IN_HAND',
  tooMany: 'SCHOOL_EXPORT_TOO_MANY',
  notReady: 'SCHOOL_EXPORT_NOT_READY',
  expired: 'SCHOOL_EXPORT_EXPIRED',
  incomplete: 'SCHOOL_EXPORT_INCOMPLETE',
} as const;

/**
 * Hela skolans data: ordering, listing, withdrawing and fetching the export
 * (K5). The administrators who decide (rektor and a full administrator) are
 * the only ones who may do any of it, and the rows say so too: the arms of
 * SchoolExports and SchoolExportChunks (20270114090000) answer nothing to
 * anyone else. A läsare, the huvudman's reader and every other profile are
 * refused here by name before the database is asked.
 *
 * Fetching records the read in the läslogg, in the transaction that opens the
 * fetch and before the first byte, one record per kind of data the file holds
 * rows about, naming those persons (SchoolExports.readAbout, which the build
 * kept): a fetch that cannot be recorded is not delivered. A second fetch
 * within 15 minutes by the same person records nothing new, as every read.
 */
@Injectable()
export class SchoolExportService {
  constructor(private readonly prisma: PrismaService) {}

  private assertMayExport(user: AuthenticatedUser): void {
    if (user.huvudman || !user.userId || !profileDecides(user.adminProfile)) {
      throw new ForbiddenException({
        message: 'Hela skolans data hämtas av rektor eller en fullständig administratör.',
        code: SCHOOL_EXPORT_CODES.decides,
      });
    }
  }

  async list(user: AuthenticatedUser): Promise<SchoolExportView[]> {
    this.assertMayExport(user);
    return this.prisma.withRls(user, async (tx) => {
      const rows = await tx.schoolExport.findMany({
        orderBy: { requestedAt: 'desc' },
        take: 20,
        select: {
          id: true, status: true, requestedAt: true, startedAt: true, finishedAt: true, expiresAt: true, byteSize: true,
          sha256: true, files: true, heldOut: true, errorClass: true, requestedById: true,
        },
      });
      const ids = [...new Set(rows.map((row) => row.requestedById).filter((id): id is string => id !== null))];
      const people = ids.length === 0 ? [] : await tx.user.findMany({ where: { id: { in: ids } }, select: { id: true, firstName: true, lastName: true } });
      const names = new Map(people.map((person) => [person.id, `${person.firstName} ${person.lastName}`.trim()]));
      // The list names who ordered, a colleague: a read of their name, written as any is.
      await recordRead(tx, 'PEOPLE', people.map((person) => person.id), user.channel);
      const now = Date.now();
      return rows.map((row) => ({
        id: row.id,
        status: row.status,
        requestedAt: row.requestedAt,
        startedAt: row.startedAt,
        finishedAt: row.finishedAt,
        expiresAt: row.expiresAt,
        byteSize: row.byteSize === null ? null : Number(row.byteSize),
        sha256: row.sha256,
        files: (row.files as FileSummary[] | null) ?? null,
        heldOut: (row.heldOut as HeldOutSummary | null) ?? null,
        errorClass: row.errorClass,
        requestedBy: row.requestedById && names.has(row.requestedById) ? { id: row.requestedById, name: names.get(row.requestedById)! } : null,
        fetchable: row.status === 'READY' && row.expiresAt !== null && row.expiresAt.getTime() > now,
      }));
    });
  }

  /** Places an order. The job takes it within half a minute. */
  async order(user: AuthenticatedUser): Promise<SchoolExportView> {
    this.assertMayExport(user);
    const created = await this.prisma.withRls(user, async (tx) => {
      const lately = await tx.schoolExport.count({ where: { requestedAt: { gt: new Date(Date.now() - 24 * 3_600_000) } } });
      if (lately >= MAX_ORDERS_PER_DAY) {
        throw new HttpException(
          { message: `Skolan har redan beställt hela sin data ${MAX_ORDERS_PER_DAY} gånger det senaste dygnet. Hämta en av de beställda filerna.`, code: SCHOOL_EXPORT_CODES.tooMany },
          HttpStatus.TOO_MANY_REQUESTS,
        );
      }
      try {
        return await tx.schoolExport.create({ data: { schoolId: user.schoolId!, requestedById: user.userId! }, select: { id: true } });
      } catch (error) {
        if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
          throw new ConflictException({
            message: 'En beställning av hela skolans data pågår redan. Vänta tills den är klar.',
            code: SCHOOL_EXPORT_CODES.inHand,
          });
        }
        throw error;
      }
    });
    const [view] = (await this.list(user)).filter((row) => row.id === created.id);
    return view!;
  }

  /** Ends an order, or withdraws a file before its time. The pieces go with the row. */
  async withdraw(id: string, user: AuthenticatedUser): Promise<void> {
    this.assertMayExport(user);
    const gone = await this.prisma.withRls(user, (tx) => tx.schoolExport.deleteMany({ where: { id } }));
    if (gone.count === 0) throw new NotFoundException('Beställningen finns inte.');
  }

  /**
   * Opens a file for fetching and records the fetch. The pieces are read after
   * this returns, a few at a time, each in a transaction of its own: the file
   * is never held.
   */
  async openFile(id: string, user: AuthenticatedUser): Promise<OpenedFile> {
    this.assertMayExport(user);
    const meta = await this.prisma.withRls(user, async (tx) => {
      const found = await tx.schoolExport.findUnique({
        where: { id },
        select: { id: true, status: true, expiresAt: true, byteSize: true, sha256: true, chunkCount: true, readAbout: true, finishedAt: true, school: { select: { slug: true } } },
      });
      if (!found) throw new NotFoundException('Beställningen finns inte.');
      if (found.status === 'EXPIRED' || (found.status === 'READY' && found.expiresAt !== null && found.expiresAt.getTime() <= Date.now())) {
        throw new GoneException({ message: 'Filen har gått ut och är raderad. Beställ en ny.', code: SCHOOL_EXPORT_CODES.expired });
      }
      if (found.status !== 'READY' || found.byteSize === null || found.sha256 === null || found.chunkCount === null) {
        throw new ConflictException({ message: 'Filen är inte klar än.', code: SCHOOL_EXPORT_CODES.notReady });
      }
      const about = (found.readAbout ?? {}) as ReadAbout;
      for (const [kind, ids] of Object.entries(about) as Array<[AccessKind, string[]]>) {
        await recordRead(tx, kind, ids, user.channel);
      }
      return found;
    });
    const byteSize = Number(meta.byteSize);
    const day = (meta.finishedAt ?? new Date()).toISOString().slice(0, 10);
    const prisma = this.prisma;
    return {
      id,
      filename: `rastra-skolexport-${meta.school.slug}-${day}.zip`.replace(/[^\w.-]+/g, '-'),
      byteSize,
      sha256: meta.sha256!,
      chunkCount: meta.chunkCount!,
      async *pieces() {
        const hash = createHash('sha256');
        let sent = 0;
        let next = 0;
        while (next < meta.chunkCount!) {
          const from = next;
          const batch = await prisma.withRls(user, (tx) =>
            tx.schoolExportChunk.findMany({
              where: { exportId: id, seq: { gte: from, lt: from + PIECES_PER_READ } },
              orderBy: { seq: 'asc' },
              select: { seq: true, bytes: true },
            }),
          );
          // A piece missing now is a file that expired or was withdrawn mid-fetch: the sender stops, and the short body tells the client.
          if (batch.length === 0 || batch[0]!.seq !== from) throw new GoneException({ message: 'Filen försvann under hämtningen.', code: SCHOOL_EXPORT_CODES.incomplete });
          for (const piece of batch) {
            if (piece.seq !== next) throw new GoneException({ message: 'Filen är ofullständig.', code: SCHOOL_EXPORT_CODES.incomplete });
            const bytes = Buffer.from(piece.bytes);
            hash.update(bytes);
            sent += bytes.length;
            next += 1;
            yield bytes;
          }
        }
        if (sent !== byteSize || hash.digest('hex') !== meta.sha256) {
          throw new GoneException({ message: 'Filen stämmer inte med sin kontrollsumma.', code: SCHOOL_EXPORT_CODES.incomplete });
        }
      },
    };
  }
}
