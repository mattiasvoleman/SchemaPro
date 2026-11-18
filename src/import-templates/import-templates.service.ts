import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { AuthenticatedUser } from '../auth/interfaces/authenticated-user.interface';
import { rethrowPrismaError } from '../common/utils/prisma-errors';
import { requireSchoolId } from '../common/utils/request-context';
import { PrismaService } from '../database/prisma.service';
import { hasPersonalNumber, scrubPersonalNumbers } from '../schedule-exchange/file-safety';
import type {
  CreateImportTemplateDto,
  ImportTemplatePlacementDto,
  ListImportTemplatesQueryDto,
  UpdateImportTemplateDto,
} from './dto/import-template.dto';
import {
  IMPORT_TEMPLATE_CONFLICTS,
  IMPORT_TEMPLATE_FIELDS,
  IMPORT_TEMPLATE_LIMIT,
  type ImportTemplateKind,
} from './import-fields';

/**
 * A school's saved column mappings (Kolumnmappning, X2; migration 20270223090000). The browser makes the mapping
 * and applies it to the file in front of it; this service keeps what the school named and nothing else: headers
 * and the field each stands for, never a value. It reads no file, applies no template and writes nothing of the
 * school's but these rows.
 *
 * Every administrator reads. Planering writes (the route says Area('PLANERING') and the database's arms ask the
 * same). The rows hold no personal data, so no read is written to the läslogg, and the one thing that could carry
 * a person in is a header somebody pasted a personnummer over: such a header is refused at the door
 * (TEMPLATE_PERSONAL_NUMBER) and scrubbed on the way out, so neither a template nor an answer holds one.
 *
 * EVERY REFUSAL HAS A CODE AND FLAT PARAMS (common/filters/http-exception.filter.ts forwards nothing else): the
 * field or the key it is about, the limit, never the value of a cell and never a header that has the shape of a
 * number.
 */

export const TEMPLATE_NAME_INVALID = 'TEMPLATE_NAME_INVALID';
export const TEMPLATE_NAME_TAKEN = 'TEMPLATE_NAME_TAKEN';
export const TEMPLATE_LIMIT = 'TEMPLATE_LIMIT';
export const TEMPLATE_UNKNOWN_FIELD = 'TEMPLATE_UNKNOWN_FIELD';
export const TEMPLATE_DUPLICATE_KEY = 'TEMPLATE_DUPLICATE_KEY';
export const TEMPLATE_DUPLICATE_FIELD = 'TEMPLATE_DUPLICATE_FIELD';
export const TEMPLATE_FIELDS_CONFLICT = 'TEMPLATE_FIELDS_CONFLICT';
export const TEMPLATE_PERSONAL_NUMBER = 'TEMPLATE_PERSONAL_NUMBER';
export const TEMPLATE_LABEL_INVALID = 'TEMPLATE_LABEL_INVALID';

/** The longest name, in characters (the database's CHECK says the same in characters of the text). */
export const TEMPLATE_NAME_MAX = 80;

const CONTROL_CHARACTERS = /[\p{Cc}\p{Cf}]/u;

export interface TemplatePlacement {
  key: string;
  label: string;
  field: string | null;
}

export interface ImportTemplateView {
  id: string;
  kind: ImportTemplateKind;
  name: string;
  headerRow: number | null;
  placements: TemplatePlacement[];
  createdAt: string;
  updatedAt: string;
}

interface Row {
  id: string;
  kind: string;
  name: string;
  headerRow: number | null;
  placements: Prisma.JsonValue;
  createdAt: Date;
  updatedAt: Date;
}

const SELECT = { id: true, kind: true, name: true, headerRow: true, placements: true, createdAt: true, updatedAt: true } as const;

/** What the web reads back. The placements are rebuilt field by field, so nothing else that was ever stored leaves. */
export function toTemplateView(row: Row): ImportTemplateView {
  const stored = Array.isArray(row.placements) ? row.placements : [];
  const placements = stored.flatMap((item): TemplatePlacement[] => {
    if (typeof item !== 'object' || item === null || Array.isArray(item)) return [];
    const { key, label, field } = item as Record<string, unknown>;
    if (typeof key !== 'string' || typeof label !== 'string') return [];
    return [{ key, label, field: typeof field === 'string' ? field : null }];
  });
  return scrubPersonalNumbers({
    id: row.id,
    kind: row.kind as ImportTemplateKind,
    name: row.name,
    headerRow: row.headerRow,
    placements,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  });
}

/** The name as the school wrote it, trimmed; refused when blank, too long, with a control character, or shaped like a personnummer. */
export function cleanTemplateName(raw: string): string {
  const name = raw.trim();
  if (name === '' || [...name].length > TEMPLATE_NAME_MAX || CONTROL_CHARACTERS.test(name)) {
    throw new BadRequestException({
      message: `name: mallens namn är 1–${TEMPLATE_NAME_MAX} tecken, utan styrtecken.`,
      code: TEMPLATE_NAME_INVALID,
      params: { max: TEMPLATE_NAME_MAX },
    });
  }
  if (hasPersonalNumber(name)) {
    throw new BadRequestException({
      message: 'name: namnet ser ut som ett personnummer. En mall har inga personuppgifter.',
      code: TEMPLATE_PERSONAL_NUMBER,
      params: { in: 'name' },
    });
  }
  return name;
}

/**
 * The posts of a template, checked against its kind: each field is one of the kind's, no field is placed twice,
 * no two fields that stand for the same cells are placed together, no key stands twice, and neither a key nor a
 * label has the shape of a personnummer. Returns the posts as they are stored. The refusals name the index of
 * the post, never its text.
 */
export function checkPlacements(kind: ImportTemplateKind, placements: readonly ImportTemplatePlacementDto[]): TemplatePlacement[] {
  const fields: readonly string[] = IMPORT_TEMPLATE_FIELDS[kind];
  const keys = new Set<string>();
  const placed = new Set<string>();
  const out: TemplatePlacement[] = [];
  placements.forEach((post, index) => {
    if (hasPersonalNumber(post.key) || hasPersonalNumber(post.label)) {
      throw new BadRequestException({
        message: 'placements: en rubrik ser ut som ett personnummer. En mall har bara rubriker, och aldrig något som liknar ett personnummer.',
        code: TEMPLATE_PERSONAL_NUMBER,
        params: { index },
      });
    }
    if (CONTROL_CHARACTERS.test(post.label)) {
      throw new BadRequestException({
        message: 'placements: en rubrik har ett styrtecken.',
        code: TEMPLATE_LABEL_INVALID,
        params: { index },
      });
    }
    if (keys.has(post.key)) {
      throw new BadRequestException({
        message: 'placements: två kolumner har samma nyckel.',
        code: TEMPLATE_DUPLICATE_KEY,
        params: { index },
      });
    }
    keys.add(post.key);
    if (post.field !== null) {
      if (!fields.includes(post.field)) {
        throw new BadRequestException({
          message: `placements: ${post.field} är inget fält för ${kind}.`,
          code: TEMPLATE_UNKNOWN_FIELD,
          params: { field: post.field, kind },
        });
      }
      if (placed.has(post.field)) {
        throw new BadRequestException({
          message: `placements: fältet ${post.field} är placerat på två kolumner. Välj en.`,
          code: TEMPLATE_DUPLICATE_FIELD,
          params: { field: post.field },
        });
      }
      placed.add(post.field);
    }
    out.push({ key: post.key, label: post.label, field: post.field });
  });
  for (const [a, b] of IMPORT_TEMPLATE_CONFLICTS[kind] ?? []) {
    if (placed.has(a) && placed.has(b)) {
      throw new BadRequestException({
        message: `placements: fälten ${a} och ${b} läser samma celler och kan inte placeras tillsammans.`,
        code: TEMPLATE_FIELDS_CONFLICT,
        params: { a, b },
      });
    }
  }
  return out;
}

const nameTaken = () =>
  new ConflictException({ message: 'name: skolan har redan en mall med det namnet för den här importen.', code: TEMPLATE_NAME_TAKEN });

@Injectable()
export class ImportTemplatesService {
  constructor(private readonly prisma: PrismaService) {}

  /** The school's templates, one kind's or all, in the order the dialogs list them: by kind, then name in Swedish. */
  async list(query: ListImportTemplatesQueryDto, user: AuthenticatedUser): Promise<ImportTemplateView[]> {
    const schoolId = requireSchoolId(user);
    const rows = await this.prisma.withRls(user, (tx) =>
      tx.importMappingTemplate.findMany({ where: { schoolId, ...(query.kind ? { kind: query.kind } : {}) }, select: SELECT }),
    );
    const collator = new Intl.Collator('sv', { numeric: true });
    return rows
      .map(toTemplateView)
      .sort((a, b) => a.kind.localeCompare(b.kind) || collator.compare(a.name, b.name));
  }

  async create(dto: CreateImportTemplateDto, user: AuthenticatedUser): Promise<ImportTemplateView> {
    const schoolId = requireSchoolId(user);
    const name = cleanTemplateName(dto.name);
    const placements = checkPlacements(dto.kind, dto.placements);
    try {
      return await this.prisma.withRls(user, async (tx) => {
        // A school has a handful of file layouts per import. A race can pass the cap by one or two, which costs nothing.
        const count = await tx.importMappingTemplate.count({ where: { schoolId, kind: dto.kind } });
        if (count >= IMPORT_TEMPLATE_LIMIT) {
          throw new ConflictException({
            message: `Skolan har redan ${IMPORT_TEMPLATE_LIMIT} mallar för den här importen. Ta bort en först.`,
            code: TEMPLATE_LIMIT,
            params: { limit: IMPORT_TEMPLATE_LIMIT },
          });
        }
        return toTemplateView(
          await tx.importMappingTemplate.create({
            data: { schoolId, kind: dto.kind, name, headerRow: dto.headerRow ?? null, placements: placements as unknown as Prisma.InputJsonValue },
            select: SELECT,
          }),
        );
      });
    } catch (error) {
      this.rethrow(error);
    }
  }

  async update(id: string, dto: UpdateImportTemplateDto, user: AuthenticatedUser): Promise<ImportTemplateView> {
    requireSchoolId(user);
    const name = dto.name === undefined ? undefined : cleanTemplateName(dto.name);
    try {
      return await this.prisma.withRls(user, async (tx) => {
        // The row the arms let the caller see; one they hide is the same 404 as one that is not there.
        const current = await tx.importMappingTemplate.findUnique({ where: { id }, select: { kind: true } });
        if (!current) throw new NotFoundException('The requested record does not exist.');
        const placements = dto.placements === undefined ? undefined : checkPlacements(current.kind as ImportTemplateKind, dto.placements);
        return toTemplateView(
          await tx.importMappingTemplate.update({
            where: { id },
            data: {
              ...(name !== undefined ? { name } : {}),
              ...(dto.headerRow !== undefined ? { headerRow: dto.headerRow } : {}),
              ...(placements !== undefined ? { placements: placements as unknown as Prisma.InputJsonValue } : {}),
            },
            select: SELECT,
          }),
        );
      });
    } catch (error) {
      this.rethrow(error);
    }
  }

  async remove(id: string, user: AuthenticatedUser): Promise<void> {
    requireSchoolId(user);
    try {
      await this.prisma.withRls(user, async (tx) => {
        // A delete finds its row under Planering's arm; a row the arms hide is the same 404 as one that is not there.
        const removed = await tx.importMappingTemplate.deleteMany({ where: { id } });
        if (removed.count === 0) throw new NotFoundException('The requested record does not exist.');
      });
    } catch (error) {
      this.rethrow(error);
    }
  }

  /** The race the check above cannot see: a second writer's name. */
  private rethrow(error: unknown): never {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') throw nameTaken();
    return rethrowPrismaError(error);
  }
}
