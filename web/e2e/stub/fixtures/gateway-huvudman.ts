import { Reply, route, type GatewayRoute } from "../gateway-routes";
import { HUVUDMAN_MEMBER } from "../sessions";
import { SCHOOL, SECOND_SCHOOL } from "./world";

/**
 * Huvudman (20261212090000): the stub's huvudman, Exempelkommun, owns the
 * fixture school and has asked for Granskolan; its kommunadministratör is
 * HUVUDMAN_MEMBER (sessions.ts). Another huvudman, Grannkommunen, has asked
 * for the fixture school too, so Dataskydd shows a question it may not say
 * yes to while the school has an owner.
 */

const AT = "2026-09-01T08:00:00.000Z";

export const HUVUDMAN_OF_STUB = {
  id: "0f0f0f0f-0000-4000-8000-000000000001",
  name: "Exempelkommun",
  organisationNumber: "2120000001",
  municipalityCode: "0884",
};
const OTHER_HUVUDMAN = { id: "0f0f0f0f-0000-4000-8000-000000000002", name: "Grannkommunen", organisationNumber: null };

/** The member's own name, as /me/schools gives it beside the school she reads. */
export const HUVUDMAN_READER = {
  role: "KOMMUNADMINISTRATOR" as const,
  memberId: "0f0f0f0f-0000-4000-8000-000000000101",
  firstName: "Karin",
  lastName: "Kommun",
};
const PLANNER = { id: "0f0f0f0f-0000-4000-8000-000000000102", firstName: "Per", lastName: "Planerare" };
const KEY = { id: "0f0f0f0f-0000-4000-8000-000000000201", name: "Kommunens elevregister" };

const unauthorised = new Reply(401, { code: "UNAUTHENTICATED" });
const mine = (authId: string | undefined) => authId === HUVUDMAN_MEMBER.authId;

export const huvudmanRoutes: GatewayRoute[] = [
  route("GET", "/api/v1/huvudman", (context) => {
    if (!context.person) return unauthorised;
    return mine(context.person.authId)
      ? [{ ...HUVUDMAN_OF_STUB, role: "KOMMUNADMINISTRATOR", memberId: HUVUDMAN_READER.memberId }]
      : [];
  }),
  route("GET", "/api/v1/huvudman/:id", (context) => {
    if (!context.person) return unauthorised;
    if (!mine(context.person.authId) || context.params.id !== HUVUDMAN_OF_STUB.id) {
      return new Reply(404, { code: "HUVUDMAN_NOT_FOUND" });
    }
    return {
      ...HUVUDMAN_OF_STUB,
      role: "KOMMUNADMINISTRATOR",
      memberId: HUVUDMAN_READER.memberId,
      schools: [
        { id: SCHOOL.id, name: SCHOOL.name, slug: SCHOOL.slug, state: "OWNED", since: AT, requestedBy: HUVUDMAN_READER.memberId },
        { id: SECOND_SCHOOL.id, name: SECOND_SCHOOL.name, slug: SECOND_SCHOOL.slug, state: "REQUESTED", since: AT, requestedBy: HUVUDMAN_READER.memberId },
      ],
      members: [
        { id: HUVUDMAN_READER.memberId, email: HUVUDMAN_MEMBER.email, firstName: HUVUDMAN_READER.firstName, lastName: HUVUDMAN_READER.lastName, role: "KOMMUNADMINISTRATOR", isActive: true, invited: true },
        { id: PLANNER.id, email: "planerare@exempelkommun.example", firstName: PLANNER.firstName, lastName: PLANNER.lastName, role: "PLANERARE", isActive: true, invited: false },
      ],
      keys: [{ ...KEY, scopes: ["organisations.read", "persons.read"], createdAt: AT, lastUsedAt: null, revokedAt: null }],
      history: [
        { at: AT, kind: "JOINED", schoolId: SCHOOL.id, schoolName: SCHOOL.name, byMember: null, bySchool: true },
        { at: AT, kind: "REQUESTED", schoolId: SECOND_SCHOOL.id, schoolName: SECOND_SCHOOL.name, byMember: HUVUDMAN_READER.memberId, bySchool: false },
      ],
    };
  }),
  // The school's side, for its administrators (Dataskydd, Integrationer).
  route("GET", "/api/v1/huvudman-ownership", (context) => {
    if (!context.person) return unauthorised;
    if (context.person.persona !== "admin") return new Reply(403, { code: "FORBIDDEN" });
    return {
      owner: { id: HUVUDMAN_OF_STUB.id, name: HUVUDMAN_OF_STUB.name, organisationNumber: HUVUDMAN_OF_STUB.organisationNumber, since: AT, acceptedBy: "Rut Rektor" },
      requests: [{ huvudmanId: OTHER_HUVUDMAN.id, name: OTHER_HUVUDMAN.name, organisationNumber: null, requestedAt: AT }],
      readers: [
        { id: HUVUDMAN_READER.memberId, firstName: HUVUDMAN_READER.firstName, lastName: HUVUDMAN_READER.lastName, role: "KOMMUNADMINISTRATOR", isActive: true, ownRow: null },
        { id: PLANNER.id, firstName: PLANNER.firstName, lastName: PLANNER.lastName, role: "PLANERARE", isActive: true, ownRow: "INACTIVE" },
      ],
      keys: [{ ...KEY, scopes: ["organisations.read", "persons.read"], createdAt: AT, lastUsedAt: null, revokedAt: null }],
      history: [{ at: AT, kind: "JOINED", huvudmanName: HUVUDMAN_OF_STUB.name, byHuvudman: false }],
    };
  }),
];
