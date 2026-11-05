import { ForbiddenException, Injectable, NotFoundException, PayloadTooLargeException } from '@nestjs/common';
import { recordRead } from '../access-log/access-log';
import { profileDecides } from '../auth/admin-areas';
import type { AuthenticatedUser } from '../auth/interfaces/authenticated-user.interface';
import { PrismaService } from '../database/prisma.service';
import { Audit, buildArchive, type BuildContext } from './build';
import { DATA_FILES } from './data-files';
import { tableFiles } from './person-tables';
import { SCHOOL_EXPORT_CODES } from './school-export.service';
import { StreamingZip, type ByteSink } from './zip-stream';

/** An extract is for one person's rows and is built in the request; past this it is a mistake, not a person. */
export const MAX_EXTRACT_BYTES = 64 * 1024 * 1024;

export interface SubjectAccessAnswer {
  filename: string;
  contentType: 'application/zip';
  contentBase64: string;
  /** For the page: whether the person is marked, and how many related persons were held out. */
  subjectIsMarked: boolean;
  relatedIncluded: number;
  relatedHeldOut: number;
}

class MemorySink implements ByteSink {
  private readonly parts: Buffer[] = [];
  private size = 0;

  async write(chunk: Buffer): Promise<void> {
    this.size += chunk.length;
    if (this.size > MAX_EXTRACT_BYTES) throw new PayloadTooLargeException('Utdraget blev större än 64 MB. Be om det i delar.');
    this.parts.push(chunk);
  }

  get bytes(): Buffer {
    return Buffer.concat(this.parts, this.size);
  }
}

/**
 * Registerutdrag (GDPR art. 15): everything Rastra holds about one person, as a
 * zip, for the administrators who decide. It is the whole-school export's code
 * with a scope: the same seven data files (data-files.ts), asked for the
 * person's rows and not the school's, and beside them one file per table that
 * holds a row about a person (person-tables.ts, which is held to the removal's
 * inventory of those tables by a test), so what the person is given is what the
 * school's own file holds about them, and more.
 *
 * "WITH THEIR GUARDIANS". A pupil's guardians, or a guardian's pupils, can come
 * with the extract (`withRelated`): each is a person of their own, their rows
 * are in it too, and a related person with a protected identity is held out
 * and counted. The person the extract is about is never held out of their own
 * extract, even when they are marked: it is their data. But an extract about a
 * marked person carries no one else, since whoever receives it may be exactly
 * the person the protection is from; the administrator is told, and checks who
 * asks.
 *
 * Built in the request, as the administrator, under row-level security. It is
 * one person's rows, tens of thousands at most. The read is recorded in the
 * läslogg, per kind of data and naming the persons the extract holds rows
 * about, before the answer leaves: an extract that cannot be recorded is not
 * delivered.
 */
@Injectable()
export class SubjectAccessService {
  constructor(private readonly prisma: PrismaService) {}

  async extract(user: AuthenticatedUser, personId: string, withRelated: boolean): Promise<SubjectAccessAnswer> {
    if (user.huvudman || !user.userId || !profileDecides(user.adminProfile)) {
      throw new ForbiddenException({
        message: 'Ett registerutdrag lämnas ut av rektor eller en fullständig administrator.',
        code: SCHOOL_EXPORT_CODES.decides,
      });
    }
    const schoolId = user.schoolId!;
    const head = await this.prisma.withRls(user, async (tx) => {
      const person = await tx.user.findUnique({ where: { id: personId }, select: { id: true } });
      if (!person) throw new NotFoundException('Personen finns inte.');
      const school = await tx.school.findUniqueOrThrow({ where: { id: schoolId }, select: { name: true } });
      const marks = await tx.$queryRaw<Array<{ id: string; first: string; last: string }>>`
        SELECT DISTINCT u."id"::text AS id, u."firstName" AS first, u."lastName" AS last
          FROM "PersonProtections" p JOIN "Users" u ON u."id" = p."userId" AND u."schoolId" = p."schoolId"
         WHERE p."schoolId" = ${schoolId}::uuid`;
      const links = withRelated
        ? await tx.guardianStudent.findMany({
            where: { OR: [{ studentId: personId }, { guardianId: personId }] },
            select: { guardianId: true, studentId: true },
          })
        : [];
      return { school: school.name, marks, links };
    });

    const marked = head.marks.map((row) => row.id);
    const subjectIsMarked = marked.includes(personId);
    const related = [...new Set(head.links.flatMap((link) => [link.guardianId, link.studentId]).filter((id) => id !== personId))];
    // A protected person's extract carries no one else; otherwise a protected related person is held out.
    const kept = subjectIsMarked ? [] : related.filter((id) => !marked.includes(id));
    const ids = [personId, ...kept];

    const audit = new Audit();
    const sink = new MemorySink();
    const zip = new StreamingZip(sink);
    const ctx: BuildContext = {
      schoolId,
      schoolName: head.school,
      now: new Date(),
      kind: 'person',
      scope: { ids },
      marked,
      exempt: [personId],
      markedNames: head.marks.map((row) => `${row.first} ${row.last}`.trim().toLowerCase()).filter((name) => name.includes(' ')),
      read: (fn) => this.prisma.withRls(user, fn),
      checkpoint: async () => undefined,
      dataFiles: DATA_FILES,
      tables: tableFiles(),
    };
    const built = await buildArchive(zip, ctx, audit);

    // Recorded before it leaves: the persons the extract holds rows about, per kind of data.
    await this.prisma.withRls(user, async (tx) => {
      for (const [kind, who] of Object.entries(built.readAbout)) await recordRead(tx, kind as never, who, user.channel);
    });

    const bytes = sink.bytes;
    return {
      filename: `registerutdrag-${new Date().toISOString().slice(0, 10)}-${personId.slice(0, 8)}.zip`,
      contentType: 'application/zip',
      contentBase64: bytes.toString('base64'),
      subjectIsMarked,
      relatedIncluded: kept.length,
      relatedHeldOut: related.length - kept.length,
    };
  }
}
