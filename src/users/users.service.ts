import { randomUUID } from 'node:crypto';
import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
  Optional,
  ServiceUnavailableException,
} from '@nestjs/common';
import { Prisma, type AdminProfile, type User, type UserRole } from '@prisma/client';
import { profileDecides } from '../auth/admin-areas';
import type { AuthenticatedUser } from '../auth/interfaces/authenticated-user.interface';
import { recordRead } from '../access-log/access-log';
import { assertAdministratorMay } from '../auth/roles.guard';
import { PrismaService } from '../database/prisma.service';
import { tellNewMentors } from '../family/leave-notices';
import { NotificationsService } from '../notifications/notifications.service';
import { requireSchoolId } from '../common/utils/request-context';
import { listNames, rethrowPrismaError } from '../common/utils/prisma-errors';
import {
  SupabaseAdminService,
  UserLookupError,
  type EmailChange,
  type LoginOwner,
} from './supabase-admin.service';
import type { CreateUserDto, UpdateUserDto } from './dto/user.dto';

/** A pseudonymised person (gallring, 20261021110000) cannot be made active again. */
export const USER_IS_PSEUDONYMISED = 'USER_IS_PSEUDONYMISED';
/** A change that would leave the school with nobody who decides (Roller i skolan). */
export const LAST_DECIDER = 'LAST_DECIDER';

/** The profiles HR-läs is given to: rektor and a full administrator read tjänst % anyway. */
const HR_READ_PROFILES: readonly AdminProfile[] = ['SCHEMALAGGARE', 'EXPEDITION', 'LASARE'];

/** What only rektor or a full administrator does (app.current_user_decides). */
const decides = (user: AuthenticatedUser): void => assertAdministratorMay(user, { kind: 'decides' });

/**
 * The profile and HR-läs a row with `role` is written with: the request's,
 * else what the row had, else FULL for an administrator, as every
 * administrator was before profiles. Nobody else has either. Refuses, as a
 * 400 in Swedish, a profile on somebody who is not an administrator and
 * HR-läs on a profile it means nothing to; the database's trigger would only
 * have dropped them silently.
 */
function profileOf(
  role: UserRole,
  requested: { adminProfile?: AdminProfile; hrRead?: boolean },
  current?: { adminProfile: AdminProfile | null; hrRead: boolean },
): { adminProfile: AdminProfile | null; hrRead: boolean } {
  if (role !== 'SCHOOL_ADMIN') {
    if (requested.adminProfile !== undefined) {
      throw new BadRequestException('Bara en administratör har en administratörsprofil.');
    }
    if (requested.hrRead === true) {
      throw new BadRequestException('HR-läs ges en administratör som är schemaläggare, expedition eller läsare.');
    }
    return { adminProfile: null, hrRead: false };
  }
  const adminProfile = requested.adminProfile ?? current?.adminProfile ?? 'FULL';
  const narrow = HR_READ_PROFILES.includes(adminProfile);
  if (requested.hrRead === true && !narrow) {
    throw new BadRequestException(
      'HR-läs ges en schemaläggare, en expedition eller en läsare. Rektor och en fullständig administratör läser tjänst % ändå.',
    );
  }
  const hrRead = narrow ? (requested.hrRead ?? (current?.adminProfile === adminProfile ? current.hrRead : false)) : false;
  return { adminProfile, hrRead };
}

/**
 * Whose post or behörighet may exist: the same two roles staff-lock.ts admits,
 * because a teaching rektor carries SCHOOL_ADMIN and is named on requirements.
 */
const isStaff = (role: UserRole): boolean => role === 'TEACHER' || role === 'SCHOOL_ADMIN';

/** "1 tjänst och 3 behörigheter", naming only what is there. */
function describeStaffingRows(
  employments: number,
  qualifications: number,
  duties: number,
  shifts = 0,
): string {
  const parts: string[] = [];
  if (employments > 0) {
    parts.push(`${employments} ${employments === 1 ? 'tjänst' : 'tjänster'}`);
  }
  if (qualifications > 0) {
    parts.push(`${qualifications} ${qualifications === 1 ? 'behörighet' : 'behörigheter'}`);
  }
  if (duties > 0) {
    // "uppdrag" is its own plural.
    parts.push(`${duties} uppdrag`);
  }
  if (shifts > 0) {
    parts.push(`${shifts} rastvaktspass`);
  }
  if (parts.length <= 1) return parts.join('');
  return `${parts.slice(0, -1).join(', ')} och ${parts[parts.length - 1]}`;
}

/** A person as the administrator's register lists them (GET /api/v1/users). */
export interface PersonView {
  id: string;
  role: UserRole;
  firstName: string;
  lastName: string;
  email: string;
  phone: string | null;
  isActive: boolean;
  studentGroupId: string | null;
  invitedAt: string | null;
}

/** How many people of each role the school has, active or not. Counts only. */
export interface UserCounts {
  byRole: Record<UserRole, number>;
}

/** Outcome of inviting one person. */
export interface InvitationResult {
  id: string;
  /**
   * False when the address already had an identity — the provider sends no
   * mail in that case, and saying otherwise would be a lie to the admin.
   */
  emailSent: boolean;
  /**
   * True when this invitation gave the person's login the address their row
   * now has. With `emailSent` false nobody told the person: their old
   * address no longer signs in, and the admin is the one to say so.
   */
  loginMoved: boolean;
  /**
   * True when the login is also another school's (Flera skolor per
   * inloggning): the person signs in as before and finds this school in
   * their school switcher. Nothing more about the other school is said.
   */
  sharedLogin: boolean;
}

/** An administrator's profile and HR-läs, as the role chooser reads them. */
export interface AdministratorView {
  id: string;
  adminProfile: AdminProfile;
  hrRead: boolean;
}

/** One change of a person's role, profile or HR-läs, as /admin/people shows it. */
export interface RoleChangeView {
  id: string;
  fromRole: UserRole | null;
  toRole: UserRole;
  fromProfile: AdminProfile | null;
  toProfile: AdminProfile | null;
  fromHrRead: boolean | null;
  toHrRead: boolean;
  /** Who made it; null for a migration, the seed, or a writer since removed. */
  actorName: string | null;
  createdAt: string;
}

/** Outcome of a bulk invitation run. */
export interface BulkInvitationReport {
  sent: number;
  alreadyRegistered: number;
  errors: { userId: string; message: string }[];
}

/**
 * User lifecycle for a school:
 *
 * 1. Admin creates a person. By default NO email is sent: the row gets a
 *    placeholder `authId` that matches no Supabase identity, so the person
 *    exists in the catalog and cannot sign in. A school builds its roster
 *    weeks before term starts, and importing 300 students must not mean
 *    emailing 300 students.
 * 2. When the admin chooses to — at creation with `sendInvitation`, or later
 *    via `invite()` — the Supabase Admin API is called (service-role key,
 *    identity only — no tenant data access), the placeholder is replaced with
 *    the returned `auth.users.id`, and `invitedAt` is stamped. The row is
 *    always written before that call goes out, never after: see `create()`.
 * 3. The person clicks the invite email, sets a password on the web app's
 *    update-password page, and can immediately sign in — RLS resolves their
 *    role and school from the `Users` row.
 * 4. Deactivation (`isActive=false`) is preferred over deletion; hard delete
 *    also removes the Supabase identity.
 */
@Injectable()
export class UsersService {
  private readonly logger = new Logger(UsersService.name);

  /**
   * NotificationsService is optional for the scripts and specs that build
   * this one by hand; without it a class move tells no mentor of the leave
   * requests it gives them (Nest always injects it).
   */
  constructor(
    private readonly prisma: PrismaService,
    private readonly supabaseAdmin: SupabaseAdminService,
    @Optional() private readonly notifications?: NotificationsService,
  ) {}

  /**
   * The school's people with their contact details: the administrator's
   * register, every picker and the people CSV (the web's usePeople). Read
   * through here rather than PostgREST so it is in the läslogg: one PEOPLE
   * record naming everyone listed, the administrator left out.
   */
  async list(user: AuthenticatedUser): Promise<PersonView[]> {
    requireSchoolId(user);
    return this.prisma.withRls(user, async (tx) => {
      const people = await tx.user.findMany({
        select: {
          id: true,
          role: true,
          firstName: true,
          lastName: true,
          email: true,
          phone: true,
          isActive: true,
          studentGroupId: true,
          invitedAt: true,
        },
        orderBy: [{ lastName: 'asc' }, { firstName: 'asc' }, { id: 'asc' }],
      });
      await recordRead(tx, 'PEOPLE', people.map((person) => person.id), user.channel);
      return people.map((person) => ({
        ...person,
        invitedAt: person.invitedAt ? person.invitedAt.toISOString() : null,
      }));
    });
  }

  /** The dashboard's figures: people per role. Names nobody, so it is not logged. */
  async counts(user: AuthenticatedUser): Promise<UserCounts> {
    requireSchoolId(user);
    const groups = await this.prisma.queryWithRls(user, (db) =>
      db.user.groupBy({ by: ['role'], _count: { _all: true } }),
    );
    const byRole: Record<UserRole, number> = { STUDENT: 0, TEACHER: 0, SCHOOL_ADMIN: 0, GUARDIAN: 0 };
    for (const group of groups) byRole[group.role] = group._count._all;
    return { byRole };
  }

  async create(dto: CreateUserDto, user: AuthenticatedUser): Promise<User> {
    const schoolId = requireSchoolId(user);

    if (dto.studentGroupId && dto.role !== 'STUDENT') {
      throw new BadRequestException('Only students can be assigned to a student group.');
    }
    // Making somebody an administrator is a decision (Roller i skolan); the
    // database's Users_administrators_are_decided says the same.
    const profile = profileOf(dto.role, dto);
    if (dto.role === 'SCHOOL_ADMIN') {
      decides(user);
    }
    // Checked before anything is written: a deployment that cannot send mail
    // must not answer "created and invited" having done only the first half.
    if (dto.sendInvitation && !this.supabaseAdmin.isConfigured) {
      throw new ServiceUnavailableException(
        'Invitations are not configured for this deployment.',
      );
    }

    // Adding someone to the catalog is not the same act as contacting them.
    // Only an explicit `sendInvitation` reaches out; otherwise the row keeps
    // the placeholder authId below, which matches no Supabase identity and
    // therefore authenticates nobody.
    //
    // The row is written first even when an invitation was asked for, because
    // the order decides who pays for a failure. Minting the identity first
    // means a rejected insert — a duplicate email is the everyday case — has
    // already put a set-password link in somebody's inbox for an account this
    // school never got, and no transaction can take that back. This way the
    // insert either succeeds or nobody has been contacted.
    let created: User;
    try {
      created = await this.prisma.withRls(user, (tx) =>
        tx.user.create({
          data: {
            schoolId,
            authId: randomUUID(),
            invitedAt: null,
            role: dto.role,
            adminProfile: profile.adminProfile,
            hrRead: profile.hrRead,
            firstName: dto.firstName,
            lastName: dto.lastName,
            email: dto.email,
            phone: dto.phone ?? null,
            studentGroupId: dto.role === 'STUDENT' ? (dto.studentGroupId ?? null) : null,
          },
        }),
      );
    } catch (error) {
      rethrowPrismaError(error);
    }

    if (!dto.sendInvitation) {
      return created;
    }

    let invite: { authId: string; emailSent: boolean };
    try {
      invite = await this.mintIdentity(dto.email, created.id);
    } catch (error) {
      // The provider refused, so take the row back: "create and invite" keeps
      // its both-or-neither promise, and the admin's retry is then just
      // pressing the button again instead of colliding with a half-made
      // person. If the refusal was really a lost answer to mail that did go
      // out, creating the person again re-adopts that same identity — GoTrue
      // answers 422 for an address it knows — so the delivered link still
      // works.
      await this.discardUninvitedRow(created.id, user);
      throw error;
    }

    const adopted = await this.adoptIdentity(created.id, invite.authId, user);
    if (adopted.sharedLogin) await this.supabaseAdmin.markSeveralSchools(invite.authId);
    return adopted.row;
  }

  /**
   * Sends (or re-sends) the invitation for one person and adopts the identity
   * the provider returns.
   *
   * Replacing `authId` is the point: until now the row held a placeholder, and
   * the person could not sign in. Re-inviting somebody who already has an
   * identity is allowed — the result simply reports that no new email went
   * out, because GoTrue sends none for an address it already knows.
   *
   * A person who was invited before has a login, and the row's address can
   * have changed since (an SS12000 apply, PERSON_EMAIL_CHANGE_INVITED) while
   * the login kept the old one. Inviting the new address as it stands would
   * mint a second login and leave the first holding the old address and any
   * password set on it, held by no row. Gallring and remove() delete only
   * the login a row holds, so it would outlive the school's decision. The
   * login therefore moves to the new address first, keeping its password
   * and linked school accounts. Where the row ends up on another login all
   * the same (another login already had the address), the one it left is
   * deleted.
   *
   * Both only for a login that is the row's own: one this row's invitation
   * created, or, created before invitations recorded that, one somebody has
   * signed in with since the row was last invited (SupabaseAdminService,
   * belongsTo). A row can also hold a login it was given by address, which
   * can be anybody's, and the row's address is the school's to set, through
   * SS12000 too. Such a login is neither moved nor deleted: the invitation
   * goes to the new address as it did before logins moved, and the login the
   * row leaves is logged with the row for an operator. The tag is the row's
   * id as the database spells it (`target.id`), never the request's, which
   * may be in upper case.
   *
   * Once the login has the row's address, moved or already there, the
   * invitation is for that login and is not resolved by address again:
   * inviteUser() reads any refusal as "already registered" and would find
   * this same login, so a send that failed would be reported as a person who
   * needs none. A login that has confirmed an address gets no invitation
   * from GoTrue anyway, and only `invitedAt` is restamped; one that has not
   * gets it again, and a failed send is the same 503 as any other.
   */
  async invite(id: string, user: AuthenticatedUser): Promise<InvitationResult> {
    if (!this.supabaseAdmin.isConfigured) {
      throw new ServiceUnavailableException(
        'Invitations are not configured for this deployment.',
      );
    }

    const target = await this.prisma.withRls(user, (tx) =>
      tx.user.findUnique({
        where: { id },
        select: { id: true, email: true, isActive: true, authId: true, invitedAt: true, role: true },
      }),
    );
    if (!target) {
      throw new NotFoundException('The requested record does not exist.');
    }
    // An administrator's login is a decider's to hand out: the invitation
    // can move it to the address the row has now.
    if (target.role === 'SCHOOL_ADMIN') {
      decides(user);
    }
    if (!target.isActive) {
      throw new BadRequestException(
        'Inactive people cannot be invited. Reactivate them first.',
      );
    }

    // Somebody never invited holds a placeholder that is nobody's login.
    // A login another school's row holds too is the person's, not this
    // school's (Flera skolor per inloggning): it is neither moved nor
    // deleted from here, and the invitation goes to the row's address as it
    // did before logins moved.
    const owner: LoginOwner | null =
      target.invitedAt === null ? null : { userId: target.id, since: target.invitedAt };
    const login = owner ? target.authId : null;
    const own = login !== null && !(await this.loginIsHeldElsewhere(login, target.id, user));
    let change: EmailChange | null = null;
    if (login && owner && own) {
      change = await this.moveLogin(login, target.email, owner);
      if (change.outcome === 'unchanged' || change.outcome === 'changed') {
        if (!change.confirmed) {
          await this.resendInvitation(target.email);
        }
        await this.adoptIdentity(id, login, user);
        return { id, emailSent: !change.confirmed, loginMoved: change.outcome === 'changed', sharedLogin: false };
      }
    }

    const invite = await this.mintIdentity(target.email, target.id);
    const adopted = await this.adoptIdentity(id, invite.authId, user);
    if (adopted.sharedLogin) await this.supabaseAdmin.markSeveralSchools(invite.authId);

    // The login the row left: the row's own when another login had the
    // address ('taken'), not the row's ('foreign'), or gone ('missing').
    if (login && owner && login !== invite.authId) {
      if (change?.outcome === 'taken') {
        await this.deleteLeftLogin(login, owner);
      } else if (change?.outcome === 'foreign') {
        this.warnLeftForeignLogin(login, owner);
      }
    }

    return { id, emailSent: invite.emailSent, loginMoved: false, sharedLogin: adopted.sharedLogin };
  }

  /**
   * Invites several people, one at a time.
   *
   * Row-wise like the CSV import, and for the same reason: each invitation is
   * an external side effect that no transaction can roll back, so one failure
   * must not discard the ones that already went out. The report names the
   * people who failed rather than the count alone.
   */
  async inviteMany(
    ids: string[],
    user: AuthenticatedUser,
  ): Promise<BulkInvitationReport> {
    const report: BulkInvitationReport = {
      sent: 0,
      alreadyRegistered: 0,
      errors: [],
    };

    for (const id of ids) {
      try {
        const result = await this.invite(id, user);
        if (result.emailSent) {
          report.sent += 1;
        } else {
          report.alreadyRegistered += 1;
        }
      } catch (error) {
        report.errors.push({
          userId: id,
          message:
            error instanceof Error
              ? error.message
              : 'Inbjudan kunde inte skickas.',
        });
      }
    }

    return report;
  }

  /**
   * The stored role and group are read under a row lock, in the transaction
   * that writes them.
   *
   * `withRls` runs READ COMMITTED, where a plain read holds nothing still.
   * Against a student with no group, a PATCH making them a teacher and a PATCH
   * putting them in 7B would each pass against the row the other has not
   * changed yet, and together try to store a teacher in 7B. The CHECK
   * Users_only_a_student_has_a_class refuses that row, but only as an unmapped
   * 500 for whichever PATCH writes second. With the lock the second PATCH waits
   * for the first to commit, is judged against what it wrote, and gets the 400.
   *
   * FOR NO KEY UPDATE rather than FOR UPDATE: see the Isolation section of
   * PrismaService. Raw SQL because Prisma has no locking read. Under RLS the
   * lock also needs the UPDATE policy to admit the row, and `users_admin_all`
   * does for the admin the controller already requires, so a user in another
   * school still reads as missing and gets the same 404.
   *
   * The same lock is the other half of src/staffing/staff-lock.ts. A post and a
   * behörighet belong to a member of staff, and the staffing writes read this
   * row FOR NO KEY UPDATE to make sure of it — which only settles the race. A
   * PATCH that makes a teacher a pupil AFTER their post was written would
   * leave a STUDENT holding a tjänstgöringsgrad and a legitimation, and the
   * load report would list a pupil among the teachers. Uppdrag (Fas 2) count
   * the same way: a pupil who is still mentor for 7B would be a row in the
   * matrix, and their rastvakt slot an UNAVAILABLE block on a pupil. So a role change out
   * of staff is refused while such rows exist, by count and in the same
   * transaction, and the sentence names what to remove first. No DB CHECK can
   * say this (cross-table), which is why it is said here.
   */
  async update(id: string, dto: UpdateUserDto, user: AuthenticatedUser): Promise<User> {
    try {
      return await this.prisma.withRls(user, async (tx) => {
        // Students-only is a rule about the row that results, not about the
        // patch, so the stored values are half the answer: a body naming only
        // a group says nothing about the role, and a body naming only a role
        // leaves any group already there in place. Both doors lead to the same
        // forbidden row, and that row is more than an untidy record —
        // app.current_user_group_id() reads studentGroupId without looking at
        // the role, so a teacher or guardian sitting in a student group is
        // handed the students' read path on that group's lessons.
        const [current] = await tx.$queryRaw<
          Pick<User, 'role' | 'studentGroupId' | 'pseudonymisedAt' | 'adminProfile' | 'hrRead' | 'isActive' | 'schoolId'>[]
        >`
          SELECT "role", "studentGroupId", "pseudonymisedAt", "adminProfile", "hrRead", "isActive", "schoolId"
          FROM "Users"
          WHERE "id" = ${id}::uuid
          FOR NO KEY UPDATE
        `;
        if (!current) {
          throw new NotFoundException('The requested record does not exist.');
        }
        // Gallring replaced the person's name, e-mail and login with a
        // pseudonym (20261021110000), and the row stays inactive
        // (Users_a_pseudonym_stays_inactive). Said here, with the way out,
        // rather than as the constraint.
        if (current.pseudonymisedAt && dto.isActive === true) {
          throw new ConflictException({
            message:
              'Personen är pseudonymiserad efter skolans gallringsbeslut och kan inte aktiveras igen. Lägg till personen på nytt.',
            code: USER_IS_PSEUDONYMISED,
          });
        }
        const role = dto.role ?? current.role;
        // Roller i skolan: an administrator's row, and anybody's role,
        // profile or HR-läs, are rektor's or a full administrator's to
        // change, as Users_administrators_are_decided holds in the database.
        const profile = profileOf(role, dto, current);
        if (
          current.role === 'SCHOOL_ADMIN' ||
          role !== current.role ||
          profile.adminProfile !== current.adminProfile ||
          profile.hrRead !== current.hrRead
        ) {
          decides(user);
        }
        const stillDecides =
          role === 'SCHOOL_ADMIN' && profileDecides(profile.adminProfile) && (dto.isActive ?? current.isActive);
        if (current.role === 'SCHOOL_ADMIN' && profileDecides(current.adminProfile) && current.isActive && !stillDecides) {
          await keepADecider(tx, current.schoolId, id);
        }
        const studentGroupId =
          dto.studentGroupId !== undefined ? dto.studentGroupId : current.studentGroupId;
        if (studentGroupId && role !== 'STUDENT') {
          throw new BadRequestException(
            'Only students can be assigned to a student group.',
          );
        }

        if (isStaff(current.role) && !isStaff(role)) {
          const [employments, qualifications, duties, shifts] = await Promise.all([
            tx.teacherEmployment.count({ where: { userId: id } }),
            tx.teacherSubjectQualification.count({ where: { userId: id } }),
            tx.teacherDuty.count({ where: { userId: id } }),
            // Rastvaktspass (20261202090000), the other half of lockStaffRow's
            // 'rastvaktspass': a pupil on the schedule would watch a break.
            tx.supervisionShift.count({ where: { userId: id } }),
          ]);
          if (employments > 0 || qualifications > 0 || duties > 0 || shifts > 0) {
            throw new ConflictException(
              `Personen kan inte bli ${role === 'STUDENT' ? 'elev' : 'vårdnadshavare'}: ${describeStaffingRows(employments, qualifications, duties, shifts)} finns registrerade. Ta bort dem under ${[employments > 0 || qualifications > 0 || duties > 0 ? 'Personer' : null, shifts > 0 ? 'Rastvaktsschema' : null].filter(Boolean).join(' och ')} först.`,
            );
          }
        }

        const updated = await tx.user.update({
          where: { id },
          data: {
            ...(dto.role !== undefined ? { role: dto.role } : {}),
            ...(profile.adminProfile !== current.adminProfile ? { adminProfile: profile.adminProfile } : {}),
            ...(profile.hrRead !== current.hrRead ? { hrRead: profile.hrRead } : {}),
            ...(dto.firstName !== undefined ? { firstName: dto.firstName } : {}),
            ...(dto.lastName !== undefined ? { lastName: dto.lastName } : {}),
            ...(dto.phone !== undefined ? { phone: dto.phone } : {}),
            ...(dto.studentGroupId !== undefined
              ? { studentGroupId: dto.studentGroupId }
              : {}),
            ...(dto.isActive !== undefined ? { isActive: dto.isActive } : {}),
          },
        });
        // A pupil's class says who their mentors are, and a teacher's role
        // and isActive whether they are one (app.leave_mentors): a move, a
        // reactivation or a role change may give a mentor a pending leave
        // request they were never told of (Mentorns ledighetsbeslut). One
        // catch-up in this transaction tells them, as the uppdrag's own
        // writes do. Only a value that changes asks: the People page sends
        // role and class with every save, and a catch-up re-sends a notice
        // gallring has removed for a request still pending.
        const moved =
          (dto.studentGroupId !== undefined && dto.studentGroupId !== current.studentGroupId) ||
          (dto.isActive !== undefined && dto.isActive !== current.isActive) ||
          (dto.role !== undefined && dto.role !== current.role);
        if (this.notifications && user.schoolId && moved) {
          await tellNewMentors(this.notifications, tx, user.schoolId);
        }
        // The answer is the whole row, e-mail and phone among them, whatever
        // the body named: a PATCH with an empty body would otherwise read a
        // person unrecorded (PEOPLE). Creating answers with what its caller
        // just typed, and is not recorded.
        await recordRead(tx, 'PEOPLE', [updated.id], user.channel);
        return updated;
      });
    } catch (error) {
      rethrowPrismaError(error);
    }
  }

  /**
   * The school's administrators with their profile and HR-läs, for the role
   * chooser on /admin/people. Every administrator reads it.
   */
  async administrators(user: AuthenticatedUser): Promise<AdministratorView[]> {
    requireSchoolId(user);
    const rows = await this.prisma.withRls(user, async (tx) => {
      const found = await tx.user.findMany({
        where: { role: 'SCHOOL_ADMIN' },
        select: { id: true, adminProfile: true, hrRead: true },
        orderBy: { id: 'asc' },
      });
      // Each administrator's profile and HR-läs: what they may change and
      // read, facts about the person, recorded as the role history records
      // them (PEOPLE). The reader's own row is their own.
      await recordRead(tx, 'PEOPLE', found.map((row) => row.id).filter((id) => id !== user.userId), user.channel);
      return found;
    });
    return rows.map((row) => ({ id: row.id, adminProfile: row.adminProfile ?? 'FULL', hrRead: row.hrRead }));
  }

  /**
   * A person's changes of role, administrator profile and HR-läs, newest
   * first, with the name of whoever made each one (null for a migration or
   * a writer since removed). Every administrator reads it; the table is
   * written by a trigger alone (UserRoleChanges, 20261110090000).
   */
  async roleChanges(id: string, user: AuthenticatedUser): Promise<RoleChangeView[]> {
    return this.prisma.withRls(user, async (tx) => {
      const changes = await tx.userRoleChange.findMany({
        where: { userId: id },
        orderBy: { createdAt: 'desc' },
        take: 50,
      });
      const actorIds = [...new Set(changes.map((c) => c.actorId).filter((a): a is string => a !== null))];
      const actors = actorIds.length
        ? await tx.user.findMany({ where: { id: { in: actorIds } }, select: { id: true, firstName: true, lastName: true } })
        : [];
      const names = new Map(actors.map((a) => [a.id, `${a.firstName} ${a.lastName}`]));
      // The person's roles and profiles, and who changed them by name: a read
      // of other people's data like the register's (PEOPLE). Nothing to record
      // for a person without history.
      if (changes.length > 0) await recordRead(tx, 'PEOPLE', [id, ...actorIds], user.channel);
      return changes.map((c) => ({
        id: c.id,
        fromRole: c.fromRole,
        toRole: c.toRole,
        fromProfile: c.fromProfile,
        toProfile: c.toProfile,
        fromHrRead: c.fromHrRead,
        toHrRead: c.toHrRead,
        actorName: c.actorId ? (names.get(c.actorId) ?? null) : null,
        createdAt: c.createdAt.toISOString(),
      }));
    });
  }

  async remove(id: string, user: AuthenticatedUser): Promise<void> {
    let authId: string | null = null;
    try {
      authId = await this.prisma.withRls(user, async (tx) => {
        const target = await tx.user.findUnique({
          where: { id },
          select: { authId: true, invitedAt: true, role: true, adminProfile: true, isActive: true, schoolId: true },
        });
        if (!target) {
          throw new NotFoundException('The requested record does not exist.');
        }
        if (target.role === 'SCHOOL_ADMIN') {
          decides(user);
          if (profileDecides(target.adminProfile) && target.isActive) {
            await keepADecider(tx, target.schoolId, id);
          }
        }
        // A decided lokal timplan names who recorded the decision, and the
        // record keeps that name: LocalTimplans_decidedByUserId_schoolId_fkey
        // is ON DELETE RESTRICT. Asked first so the answer names the plans
        // and the way out, instead of the generic "references a record".
        const decided = await tx.localTimplan.findMany({
          where: { decidedByUserId: id },
          select: { name: true },
          orderBy: { name: 'asc' },
        });
        if (decided.length > 0) {
          throw recordedATimplanDecision(decided.map((plan) => plan.name));
        }
        await tx.user.delete({ where: { id } });
        // Somebody who was never contacted has no identity to delete: `authId`
        // is a placeholder uuid written at create time and matching nothing at
        // the provider. Asking it to delete one produced a warning that read
        // like a failure on every removal of an uninvited person, which is most
        // of them while a school is still building its catalog.
        return target.invitedAt === null ? null : target.authId;
      });
    } catch (error) {
      if (error instanceof NotFoundException || error instanceof ConflictException) throw error;
      // A plan decided by this person between the question and the delete.
      if (isDeciderReference(error)) throw recordedATimplanDecision([]);
      rethrowPrismaError(error);
    }

    // Best effort: also remove the Supabase identity so the email can be
    // re-invited later. The tenant row is already gone; an orphaned identity
    // grants no data access (RLS finds no Users row). A login another
    // school's row still holds is the person's, and stays (Flera skolor per
    // inloggning); asked after the delete, so any row that holds it counts.
    if (authId && !(await this.loginIsHeldElsewhere(authId, null, user))) {
      try {
        await this.supabaseAdmin.deleteUser(authId);
      } catch {
        this.logger.warn('Failed to delete the Supabase identity for a removed user.');
      }
    }
  }

  /**
   * Asks the provider for the identity behind an address, minting one for
   * row `id` if needed.
   */
  private async mintIdentity(
    email: string,
    id: string,
  ): Promise<{ authId: string; emailSent: boolean }> {
    try {
      return await this.supabaseAdmin.inviteUser(email, id);
    } catch {
      this.logger.error('Supabase invite failed.'); // no PII in logs
      throw new ServiceUnavailableException(
        'Could not send the invitation email. Please try again.',
      );
    }
  }

  /**
   * Gives a person's login the address their row now has (see invite()).
   *
   * Another login holding that address (`taken`) is not a failure: the
   * invitation then resolves to that login, as it did before logins moved,
   * and invite() deletes the one the row leaves. A login that is gone
   * (`missing`) has nothing to move, and one that is not the row's own
   * (`foreign`) is not moved: the invitation then goes to the new address as
   * it did before.
   */
  private async moveLogin(authId: string, email: string, owner: LoginOwner): Promise<EmailChange> {
    try {
      return await this.supabaseAdmin.changeUserEmail(authId, email, owner);
    } catch {
      this.logger.error('Supabase e-mail change failed.'); // no PII in logs
      throw new ServiceUnavailableException(
        'Could not send the invitation email. Please try again.',
      );
    }
  }

  /** Sends the invitation again to a login that has not accepted it. */
  private async resendInvitation(email: string): Promise<void> {
    try {
      await this.supabaseAdmin.resendInvitation(email);
    } catch {
      this.logger.error('Supabase invite failed.'); // no PII in logs
      throw new ServiceUnavailableException(
        'Could not send the invitation email. Please try again.',
      );
    }
  }

  /**
   * Deletes the login a row has just moved off.
   *
   * Not the compensation adoptIdentity() warns against: that would delete the
   * identity a row was about to take. This one the row held until a moment
   * ago, and since `authId` is unique no row holds it now: nothing reaches
   * the school through it. What it still keeps is the old address and any
   * password set on it.
   *
   * Only if it is the row's own: invite() asks only for a login
   * changeUserEmail found to be the row's, and the provider reads it again
   * here. One that is not after all is left and logged as such
   * (warnLeftForeignLogin), and one that cannot be read is left with a line
   * of its own. Whose either is, is the operator's to find out before
   * deleting it.
   *
   * Best effort, as in remove(): the invitation went out and the row is
   * right. The pair logged when the delete itself fails ("was not deleted")
   * is what an operator deletes by hand; both are opaque ids.
   */
  private async deleteLeftLogin(authId: string, owner: LoginOwner): Promise<void> {
    const id = owner.userId;
    try {
      const deletion = await this.supabaseAdmin.deleteOwnedUser(authId, owner);
      if (deletion === 'foreign') this.warnLeftForeignLogin(authId, owner);
    } catch (error) {
      this.logger.warn(
        error instanceof UserLookupError
          ? `The login a re-invited row moved off was left, whose it is not checked [user=${id}] [authId=${authId}]`
          : `The login a re-invited row moved off was not deleted [user=${id}] [authId=${authId}]`,
      );
    }
  }

  /** Logs a login a re-invited row left that is not the row's own. */
  private warnLeftForeignLogin(authId: string, owner: LoginOwner): void {
    this.logger.warn(
      `The login a re-invited row moved off is not the row's own and was left [user=${owner.userId}] [authId=${authId}]`,
    );
  }

  /**
   * Points a row at the identity the provider just handed us.
   *
   * When this write fails the identity stays where it is. Deleting it as
   * compensation would be the wrong instinct twice over: `inviteUser` also
   * answers with identities it did NOT create — an address already known to
   * GoTrue resolves to the existing one, which may well belong to somebody
   * signed in at another school — and even when the identity is ours, the
   * invitation link has already been delivered, so removing it turns a mail
   * the person is holding into a dead end. Left alone, the same link keeps
   * working: a retry re-adopts the identity (GoTrue answers 422 for a known
   * address and SupabaseAdminService looks the id up) and links the row.
   *
   * What we owe instead is a trail. The pair logged below is what reconciles
   * a stranded identity with the row that should be carrying it; both are
   * opaque ids, so nothing about the person reaches the log.
   *
   * The identity may be one another school's row already holds: the person
   * has a login from there (Flera skolor per inloggning). This is the one
   * writer that may give a row such a login. The database refuses every
   * other (trigger Users_a_login_joins_another_school_by_invitation, 23505)
   * unless the transaction names the row in app.login_join, which is set
   * here. `sharedLogin` says whether the login is another row's too.
   */
  private async adoptIdentity(
    id: string,
    authId: string,
    user: AuthenticatedUser,
  ): Promise<{ row: User; sharedLogin: boolean }> {
    try {
      return await this.prisma.withRls(user, async (tx) => {
        await tx.$executeRaw`SELECT set_config('app.login_join', ${id}, true)`;
        const row = await tx.user.update({
          where: { id },
          data: { authId, invitedAt: new Date() },
        });
        const [held] = await tx.$queryRaw<Array<{ held: boolean }>>`
          SELECT app.login_is_held_elsewhere(${authId}::uuid, ${id}::uuid) AS held`;
        return { row, sharedLogin: held?.held === true };
      });
    } catch (error) {
      this.logger.error(
        `Invitation identity was not linked to its row [user=${id}] [authId=${authId}]`,
      );
      rethrowPrismaError(error);
    }
  }

  /**
   * Whether a row other than `userId` holds the login (app.login_is_held_elsewhere,
   * 20261204090000); with `userId` null, whether any row does. A shared
   * login is the person's: a caller that would delete or move it leaves it
   * instead. Fails safe: a question that cannot be answered counts as held,
   * and a login is left rather than deleted from under another school.
   */
  private async loginIsHeldElsewhere(
    authId: string,
    userId: string | null,
    user: AuthenticatedUser,
  ): Promise<boolean> {
    try {
      const [answer] = await this.prisma.queryWithRls(user, (db) =>
        db.$queryRaw<Array<{ held: boolean }>>`
          SELECT app.login_is_held_elsewhere(${authId}::uuid, ${userId}::uuid) AS held`,
      );
      return answer?.held !== false;
    } catch {
      this.logger.warn(`Could not ask whether a login is shared; it is left [authId=${authId}]`);
      return true;
    }
  }

  /**
   * Drops a row created moments ago for an invitation that never went out.
   *
   * Safe in the way the mirror-image compensation is not: this row is ours, it
   * is seconds old, it carries a placeholder identity and nothing references
   * it yet.
   */
  private async discardUninvitedRow(
    id: string,
    user: AuthenticatedUser,
  ): Promise<void> {
    try {
      await this.prisma.withRls(user, (tx) => tx.user.delete({ where: { id } }));
    } catch {
      // Not worth failing over: a row with a placeholder identity is the
      // ordinary state of somebody a school has added but not yet contacted.
      // The admin still hears about the invitation, which is the real failure.
      this.logger.warn('Could not remove a user row after a failed invitation.');
    }
  }
}

/**
 * The 409 for removing someone a decided timplan names as its decider. A
 * decision's who is part of the record; the person is deactivated instead,
 * which keeps the name on the plan and takes every access away.
 */
function recordedATimplanDecision(planNames: string[]): ConflictException {
  const which =
    planNames.length === 0
      ? 'en beslutad lokal timplan'
      : planNames.length === 1
        ? `den beslutade lokala timplanen ${listNames(planNames)}`
        : `de beslutade lokala timplanerna ${listNames(planNames)}`;
  return new ConflictException(
    `Personen står som den som registrerade beslutet om ${which} och kan inte tas bort. ` +
      'Inaktivera kontot i stället; beslutet behåller sitt namn.',
  );
}

/** The restrict foreign key from a decided plan to its decider, as the pg adapter reports it. */
function isDeciderReference(error: unknown): boolean {
  return (
    error instanceof Prisma.PrismaClientKnownRequestError &&
    error.code === 'P2003' &&
    JSON.stringify(error.meta ?? {}).includes('LocalTimplans_decidedByUserId_schoolId_fkey')
  );
}

/**
 * Refuses a change that would leave the school with no active rektor or full
 * administrator, who alone can make anybody else one. Every such row is
 * locked first, so two administrators demoting each other at once cannot
 * both pass: the second waits, and then counts the first's change.
 */
async function keepADecider(tx: Prisma.TransactionClient, schoolId: string, leaving: string): Promise<void> {
  const deciders = await tx.$queryRaw<{ id: string }[]>`
    SELECT "id" FROM "Users"
     WHERE "schoolId" = ${schoolId}::uuid AND "role" = 'SCHOOL_ADMIN'
       AND "adminProfile" IN ('FULL', 'REKTOR') AND "isActive"
     ORDER BY "id"
     FOR NO KEY UPDATE
  `;
  if (!deciders.some((row) => row.id !== leaving)) {
    throw new ConflictException({
      message:
        'Skolan behöver minst en aktiv rektor eller fullständig administratör. Ge någon annan den rollen först.',
      code: LAST_DECIDER,
    });
  }
}
