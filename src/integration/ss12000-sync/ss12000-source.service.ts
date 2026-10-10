import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { Prisma, type PrismaClient, type Ss12000SecretKind, type Ss12000Source } from '@prisma/client';
import type { AuthenticatedUser } from '../../auth/interfaces/authenticated-user.interface';
import { requireSchoolId } from '../../common/utils/request-context';
import { PrismaService } from '../../database/prisma.service';
import { Ss12000Client } from './client';
import { bindingFor, connectionOf, localDate, openSecrets, readSealed } from './connection';
import type { Ss12000ScheduleDto, Ss12000SourceDto } from './dto';
import { sourceErrorCode, sqlStateOf } from './errors';
import { originOf, vetSourceUrl } from './outbound';
import { parseOrganisation } from './s1';
import { secretValueProblem } from './secret-box';
import { Ss12000Outbound, Ss12000Secrets } from './ss12000-sync.providers';

/** What GET /api/v1/ss12000-source answers: the configuration, and of the secrets only whether and when. */
export type SourceView = Omit<Ss12000Source, 'schedulerClaimedAt'> & {
  secrets: Partial<Record<Ss12000SecretKind, { setAt: Date }>>;
};

export interface ConnectionTest {
  ok: boolean;
  code: string;
  tokenOk: boolean;
  organisations: Array<{ id: string; displayName: string; schoolUnitCode: string | null; organisationType: string }>;
}

const SECRET_KINDS: Ss12000SecretKind[] = ['CLIENT_SECRET', 'BEARER_TOKEN', 'CLIENT_KEY_PEM', 'CLIENT_CERT_PEM'];

/** At most this many skolenheter are listed by "Testa anslutning". */
const TEST_ORGANISATIONS_MAX = 500;

/**
 * The school's SS12000 source: its configuration, its write-only
 * credentials, "Testa anslutning" and the schedule. SCHOOL_ADMIN only
 * (the controller's @Roles, and the RLS arms of 20261014090000 under it).
 *
 * A credential goes in through PUT …/secrets/:kind, sealed with
 * INTEGRATION_SECRETS_KEY and bound to the origin it is sent to, and never
 * comes back out: GET answers {kind: {setAt}} and nothing else, and the
 * connection test answers a code and the skolenheter, never what the far
 * side said. A change of host clears the credentials bound to the old one
 * in the same transaction, so the stored secret cannot be redirected.
 */
@Injectable()
export class Ss12000SourceService {
  private readonly logger = new Logger(Ss12000SourceService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly secrets: Ss12000Secrets,
    private readonly outbound: Ss12000Outbound,
  ) {}

  async get(user: AuthenticatedUser): Promise<SourceView> {
    const schoolId = requireSchoolId(user);
    return this.prisma.withRls(user, async (tx) => {
      const source = await tx.ss12000Source.findFirst({ where: { schoolId } });
      if (!source) throw new NotFoundException({ message: 'Skolan har inget källsystem.', code: 'SS12000_SOURCE_NOT_FOUND' });
      return this.view(tx, source);
    });
  }

  private async view(tx: PrismaClient, source: Ss12000Source): Promise<SourceView> {
    const presence = await tx.$queryRaw<Array<{ kind: Ss12000SecretKind; set_at: Date }>>(
      Prisma.sql`SELECT kind, set_at FROM app.ss12000_source_secret_presence(${source.id}::uuid)`,
    );
    const { schedulerClaimedAt: _claimed, ...rest } = source;
    void _claimed;
    return {
      ...rest,
      secrets: Object.fromEntries((presence ?? []).map((row) => [row.kind, { setAt: row.set_at }])),
    };
  }

  async put(user: AuthenticatedUser, dto: Ss12000SourceDto): Promise<SourceView> {
    const schoolId = requireSchoolId(user);
    const baseUrl = vetSourceUrl(dto.baseUrl, 'base');
    if (!baseUrl) throw new BadRequestException({ message: 'baseUrl: https, utan inloggningsuppgifter, fråga eller avslutande snedstreck.', code: 'SS12000_URL_INVALID' });
    const tokenUrl = dto.tokenUrl ?? null;
    if (tokenUrl !== null && !vetSourceUrl(tokenUrl, 'token')) {
      throw new BadRequestException({ message: 'tokenUrl: https, utan inloggningsuppgifter, fråga eller fragment.', code: 'SS12000_URL_INVALID' });
    }
    const clientId = dto.clientId ?? null;
    if ((tokenUrl === null) !== (clientId === null)) {
      throw new BadRequestException({ message: 'tokenUrl och clientId anges tillsammans.', code: 'SS12000_CLIENT_INCOMPLETE' });
    }
    if (dto.authKind === 'OAUTH2_CLIENT_CREDENTIALS' && tokenUrl === null) {
      throw new BadRequestException({ message: 'OAuth2 behöver tokenUrl och clientId.', code: 'SS12000_CLIENT_INCOMPLETE' });
    }
    if (dto.authKind === 'BEARER_TOKEN' && tokenUrl !== null) {
      throw new BadRequestException({ message: 'En statisk token har ingen tokenUrl.', code: 'SS12000_CLIENT_INCOMPLETE' });
    }
    const organisationIds = dto.organisationIds ? [...new Set(dto.organisationIds.map((id) => id.toLowerCase()))] : undefined;

    return this.prisma.withRls(user, async (tx) => {
      const existing = await tx.ss12000Source.findFirst({ where: { schoolId } });
      const config = {
        name: dto.name.trim(),
        baseUrl: dto.baseUrl,
        authKind: dto.authKind,
        tokenUrl,
        clientId,
        tokenScope: dto.tokenScope ?? null,
        tokenAuthStyle: dto.tokenAuthStyle ?? 'BASIC',
        ...(organisationIds ? { organisationIds } : {}),
        ...(dto.pageSize !== undefined ? { pageSize: dto.pageSize } : {}),
        ...(dto.enabled !== undefined ? { enabled: dto.enabled } : {}),
      };
      if (!existing) {
        const created = await tx.ss12000Source.create({
          data: { schoolId, ...config, createdById: user.userId ?? null },
        });
        return this.view(tx, created);
      }

      const baseMoved = originOf(existing.baseUrl) !== originOf(dto.baseUrl);
      const tokenMoved = (existing.tokenUrl ? originOf(existing.tokenUrl) : null) !== (tokenUrl ? originOf(tokenUrl) : null);
      const sameOrganisations =
        !organisationIds ||
        (organisationIds.length === existing.organisationIds.length && organisationIds.every((id) => existing.organisationIds.includes(id)));
      // Another register, or another skolenhet in it: the ids stored on our
      // rows may mean somebody else there.
      const relink = baseMoved || !sameOrganisations;
      if (relink && existing.organisationIds.length > 0) {
        const linked =
          (await tx.user.count({ where: { schoolId, ss12000Id: { not: null } } })) +
          (await tx.studentGroup.count({ where: { schoolId, ss12000Id: { not: null } } }));
        if (linked > 0 && dto.confirmRelink !== true) {
          throw new ConflictException({
            message: 'Personer och klasser är kopplade till källsystemet. Bekräfta att organisationen eller adressen byts; nästa synk blir en full synk.',
            code: 'SS12000_SOURCE_RELINK_REQUIRED',
            params: { linked },
          });
        }
      }
      // A credential is bound to the host it is sent to: a new host needs it typed again.
      const clear: Ss12000SecretKind[] = [
        ...(baseMoved ? (['BEARER_TOKEN', 'CLIENT_KEY_PEM', 'CLIENT_CERT_PEM'] as const) : []),
        ...(tokenMoved ? (['CLIENT_SECRET'] as const) : []),
      ];
      if (clear.length > 0) {
        await tx.$queryRaw(
          Prisma.sql`SELECT app.ss12000_clear_source_secrets(${existing.id}::uuid, ${clear}::"Ss12000SecretKind"[])`,
        );
      }
      const updated = await tx.ss12000Source.update({
        where: { id: existing.id },
        data: {
          ...config,
          ...(relink ? { modifiedCursor: null, deletedCursor: null, lastFullAt: null, incrementalUnsupported: false } : {}),
          ...(baseMoved ? { schoolUnitCodes: [] } : {}),
        },
      });
      if (clear.length > 0) this.logger.log(`SS12000 source credentials cleared [school=${schoolId}, kinds=${clear.join(',')}]`);
      return this.view(tx, updated);
    });
  }

  async putSecret(user: AuthenticatedUser, kind: Ss12000SecretKind, value: string): Promise<{ kind: Ss12000SecretKind; setAt: Date }> {
    const schoolId = requireSchoolId(user);
    if (!this.secrets.box.configured) {
      throw new ServiceUnavailableException({
        message: 'Hemligheter kan inte sparas: INTEGRATION_SECRETS_KEY är inte konfigurerad.',
        code: 'SS12000_SECRETS_NOT_CONFIGURED',
      });
    }
    const problem = secretValueProblem(kind, value);
    if (problem) throw new BadRequestException({ message: 'Värdet har inte rätt form för sin typ.', code: problem });
    return this.prisma.withRls(user, async (tx) => {
      const source = await tx.ss12000Source.findFirst({ where: { schoolId } });
      if (!source) throw new NotFoundException({ message: 'Skolan har inget källsystem.', code: 'SS12000_SOURCE_NOT_FOUND' });
      const binding = bindingFor(source, kind);
      if (!binding) throw new ConflictException({ message: 'En klienthemlighet behöver en tokenUrl.', code: 'SS12000_SOURCE_NO_TOKEN_URL' });
      const sealed = this.secrets.box.seal(value, binding);
      try {
        const [row] = await tx.$queryRaw<Array<{ set_at: Date }>>(
          Prisma.sql`SELECT app.ss12000_set_source_secret(${source.id}::uuid, ${kind}::"Ss12000SecretKind", ${sealed.ciphertext}, ${sealed.iv}, ${sealed.authTag}, ${sealed.keyId}) AS set_at`,
        );
        this.logger.log(`SS12000 source credential set [school=${schoolId}, kind=${kind}]`);
        return { kind, setAt: row?.set_at ?? new Date() };
      } catch (error) {
        if (sqlStateOf(error) === 'SS403') throw new ForbiddenException({ message: 'Bara skolans administratör.', code: 'SS12000_SECRET_REFUSED' });
        throw error;
      }
    });
  }

  async clearSecret(user: AuthenticatedUser, kind: Ss12000SecretKind): Promise<{ kind: Ss12000SecretKind; cleared: boolean }> {
    const schoolId = requireSchoolId(user);
    return this.prisma.withRls(user, async (tx) => {
      const source = await tx.ss12000Source.findFirst({ where: { schoolId }, select: { id: true } });
      if (!source) throw new NotFoundException({ message: 'Skolan har inget källsystem.', code: 'SS12000_SOURCE_NOT_FOUND' });
      const [row] = await tx.$queryRaw<Array<{ cleared: number }>>(
        Prisma.sql`SELECT app.ss12000_clear_source_secrets(${source.id}::uuid, ARRAY[${kind}]::"Ss12000SecretKind"[]) AS cleared`,
      );
      return { kind, cleared: Number(row?.cleared ?? 0) > 0 };
    });
  }

  /**
   * "Testa anslutning": obtain a token (or check the stored one), then list
   * the source's skolenheter (GET /organisations?type=Skolenhet, at most
   * 500) for the admin to pick from. No database transaction is open while
   * the source is called; the outcome code is written afterwards.
   */
  async test(user: AuthenticatedUser): Promise<ConnectionTest> {
    const schoolId = requireSchoolId(user);
    const { source, rows } = await this.prisma.withRls(user, async (tx) => {
      const found = await tx.ss12000Source.findFirst({ where: { schoolId } });
      if (!found) throw new NotFoundException({ message: 'Skolan har inget källsystem.', code: 'SS12000_SOURCE_NOT_FOUND' });
      return { source: found, rows: await readSealed(tx, found.id) };
    });

    const result: ConnectionTest = { ok: false, code: 'SS12000_UNEXPECTED', tokenOk: false, organisations: [] };
    try {
      const client = new Ss12000Client(connectionOf(source, openSecrets(this.secrets.box, source, rows)), this.outbound.clientOptions());
      await client.authenticate();
      result.tokenOk = true;
      const items = await client.list('/organisations', [['type', 'Skolenhet']], Math.min(source.pageSize, TEST_ORGANISATIONS_MAX), TEST_ORGANISATIONS_MAX);
      for (const item of items.slice(0, TEST_ORGANISATIONS_MAX)) {
        const parsed = parseOrganisation(item);
        if (parsed.ok) {
          const { id, displayName, schoolUnitCode, organisationType } = parsed.value;
          result.organisations.push({ id, displayName, schoolUnitCode, organisationType });
        }
      }
      result.ok = true;
      result.code = 'OK';
    } catch (error) {
      result.code = sourceErrorCode(error);
    }

    await this.prisma.withRls(user, (tx) =>
      tx.ss12000Source.update({ where: { id: source.id }, data: { lastTestedAt: new Date(), lastTestOutcome: result.code } }),
    );
    this.logger.log(`SS12000 connection test [school=${schoolId}, outcome=${result.code}, organisations=${result.organisations.length}]`);
    return result;
  }

  async patchSchedule(user: AuthenticatedUser, dto: Ss12000ScheduleDto): Promise<SourceView> {
    const schoolId = requireSchoolId(user);
    return this.prisma.withRls(user, async (tx) => {
      const source = await tx.ss12000Source.findFirst({ where: { schoolId } });
      if (!source) throw new NotFoundException({ message: 'Skolan har inget källsystem.', code: 'SS12000_SOURCE_NOT_FOUND' });
      const scheduleEnabled = dto.scheduleEnabled ?? source.scheduleEnabled;
      const scheduleAutoApply = scheduleEnabled ? (dto.scheduleAutoApply ?? source.scheduleAutoApply) : false;
      let lastScheduledLocalDate: Date | undefined;
      if (scheduleEnabled && !source.scheduleEnabled) {
        // Turned on today: the first scheduled run is the coming night, not
        // the next five-minute tick of the afternoon.
        const school = await tx.school.findFirst({ where: { id: schoolId }, select: { timezone: true } });
        lastScheduledLocalDate = new Date(`${localDate(school?.timezone ?? 'Europe/Stockholm')}T00:00:00Z`);
      }
      const updated = await tx.ss12000Source.update({
        where: { id: source.id },
        data: {
          scheduleEnabled,
          scheduleAutoApply,
          ...(dto.scheduleHourLocal !== undefined ? { scheduleHourLocal: dto.scheduleHourLocal } : {}),
          ...(dto.fullEveryDays !== undefined ? { fullEveryDays: dto.fullEveryDays } : {}),
          ...(lastScheduledLocalDate ? { lastScheduledLocalDate } : {}),
        },
      });
      this.logger.log(`SS12000 schedule [school=${schoolId}, enabled=${scheduleEnabled}, autoApply=${scheduleAutoApply}]`);
      return this.view(tx, updated);
    });
  }
}

export { SECRET_KINDS };
