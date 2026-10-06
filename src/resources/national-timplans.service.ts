import { Injectable } from '@nestjs/common';
import type { SchoolForm, TimplanStage } from '@prisma/client';
import type { AuthenticatedUser } from '../auth/interfaces/authenticated-user.interface';
import { PrismaService } from '../database/prisma.service';
import { requireSchoolId } from '../common/utils/request-context';

/** One printed cell of a bilaga. See NationalTimplanEntry in the schema. */
export interface NationalTimplanEntryResponse {
  subjectCode: string;
  stage: TimplanStage;
  hours: number;
  minimumHoursPerChild: number | null;
  protectedFromReduction: boolean;
}

/**
 * One lydelse of one bilaga. A version with no entries is a law whose
 * fördelning Skolverket has not published yet (SFS 2025:729), and must be
 * rendered as that — never as 0 h in every cell.
 */
export interface NationalTimplanVersionResponse {
  id: string;
  code: string;
  sfs: string;
  title: string;
  schoolForm: SchoolForm;
  totalHours: number;
  skolansValHours: number | null;
  reductionCapPercent: number | null;
  appliesFromCohortTerm: string;
  supersededByCode: string | null;
  entries: NationalTimplanEntryResponse[];
}

export interface NationalSubjectResponse {
  code: string;
  name: string;
  parentCode: string | null;
  isGroup: boolean;
}

export interface NationalTimplansResponse {
  versions: NationalTimplanVersionResponse[];
  subjects: NationalSubjectResponse[];
}

/**
 * The national timplan as the gateway hands it out: every seeded version with
 * its cells, and the ämnen the cells and Subject.nationalCode name.
 *
 * ONE DOCUMENT, NOT A COLLECTION. The statute is small (six versions, 180
 * cells, 28 ämnen) and read whole by every page that reads it at all — a
 * subjects dialog needs the subject list, a coverage page needs versions and
 * cells and names in one go. Paging or per-version routes would be three
 * requests for a payload under 30 KB, and the one document is what makes a
 * single ETag mean something.
 *
 * ORDERED BY KEY THROUGHOUT, so the same database state serialises to the same
 * bytes and the ETag Express derives from them is stable across requests and
 * pods. Without an ORDER BY PostgreSQL may hand rows back in any order, and a
 * client's If-None-Match would miss on a payload that changed in nothing but
 * row order. Versions by code, entries by (subjectCode, stage), subjects by
 * code — the web sorts for display.
 *
 * READ UNDER withRls, like every other read, although the tables carry no
 * schoolId: their SELECT policy requires an active signed-in principal
 * (`app.current_user_id() IS NOT NULL`), which is what keeps a deactivated
 * account and the SS12000 service principal from reading the statute through
 * the API role. requireSchoolId is the same check from the other side — a
 * principal with no Users row has no school and no current_user_id, and
 * would read six empty tables; a 403 says so, an empty 200 would not.
 */
@Injectable()
export class NationalTimplansService {
  constructor(private readonly prisma: PrismaService) {}

  async get(user: AuthenticatedUser): Promise<NationalTimplansResponse> {
    requireSchoolId(user);
    return this.prisma.withRls(user, async (tx) => {
      const versions = await tx.nationalTimplanVersion.findMany({
        orderBy: { code: 'asc' },
        select: {
          id: true,
          code: true,
          sfs: true,
          title: true,
          schoolForm: true,
          totalHours: true,
          skolansValHours: true,
          reductionCapPercent: true,
          appliesFromCohortTerm: true,
          supersededByCode: true,
          entries: {
            orderBy: [{ subjectCode: 'asc' }, { stage: 'asc' }],
            select: {
              subjectCode: true,
              stage: true,
              hours: true,
              minimumHoursPerChild: true,
              protectedFromReduction: true,
            },
          },
        },
      });
      const subjects = await tx.nationalSubject.findMany({
        orderBy: { code: 'asc' },
        select: { code: true, name: true, parentCode: true, isGroup: true },
      });
      return { versions, subjects };
    });
  }
}
