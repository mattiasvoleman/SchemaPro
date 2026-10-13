import type { AdministratorProfile, RoleChange } from "../../../lib/admin-role-queries";
import { Reply, route, type GatewayContext, type GatewayRoute } from "../gateway-routes";
import { NOW } from "./calendar";
import { ALL_PEOPLE } from "./world";

/**
 * Roller i skolan (src/users): the administrators' profiles, which
 * /admin/people reads to lock the rows only rektor changes, and a person's
 * role history, which the page reads when a row is opened. The school's one
 * administrator is full, as the session reads them (no adminProfile on the
 * stub's own row reads as full), and became one by the import, which no
 * person made.
 */

const unauthorised = new Reply(401, { message: "Not authenticated." });

const adminsOnly = (context: GatewayContext) =>
  !context.person ? unauthorised : context.person.persona === "admin" ? null : new Reply(403, { message: "Forbidden." });

const ADMINISTRATORS: AdministratorProfile[] = ALL_PEOPLE.filter((person) => person.role === "SCHOOL_ADMIN").map(
  (person) => ({ id: person.id, adminProfile: "FULL", hrRead: false }),
);

export const roleRoutes: GatewayRoute[] = [
  route("GET", "/api/v1/users/administrators", (context): AdministratorProfile[] | Reply => adminsOnly(context) ?? ADMINISTRATORS),

  route("GET", "/api/v1/users/:id/role-changes", (context): RoleChange[] | Reply => {
    const refused = adminsOnly(context);
    if (refused) return refused;
    const administrator = ADMINISTRATORS.find((row) => row.id === context.params.id);
    return administrator
      ? [
          {
            id: `role-change-${administrator.id}`,
            fromRole: null,
            toRole: "SCHOOL_ADMIN",
            fromProfile: null,
            toProfile: administrator.adminProfile,
            fromHrRead: null,
            toHrRead: administrator.hrRead,
            actorName: null,
            createdAt: NOW,
          },
        ]
      : [];
  }),
];
