import type { LeaveContact, LeavePolicy, LeaveRequest } from "@/lib/types";

/**
 * Ledighetspolicy (K4), the parts of it that need no React: what the family's
 * form holds of the temporary contact, and whether a request has anything
 * beyond the plain row to say. Everything is off as delivered, and a page
 * shows only what the policy or the answer says.
 */

/** The gateway's phone rule (CreateLeaveRequestDto): 5 to 30 characters of digits, spaces and + ( ) -. */
const PHONE = /^[0-9 +()-]{5,30}$/;

export const EMPTY_CONTACT: LeaveContact = { name: "", phone: "", relation: "" };

/** Why the contact in the form cannot be sent yet; null when it can (also when the school does not ask for one). */
export type ContactProblem = "REQUIRED" | "INCOMPLETE" | "PHONE";

export function contactProblem(ask: LeavePolicy["contact"], contact: LeaveContact): ContactProblem | null {
  if (ask === "OFF") return null;
  const given = [contact.name, contact.phone, contact.relation].filter((value) => value.trim() !== "").length;
  // All three or none, as the gateway has it; none is a problem only where the school requires one.
  if (given === 0) return ask === "REQUIRED" ? "REQUIRED" : null;
  if (given < 3) return "INCOMPLETE";
  return PHONE.test(contact.phone.trim()) ? null : "PHONE";
}

/** The contact fields of the create body: none when the school does not ask or the form holds none. */
export function contactFields(ask: LeavePolicy["contact"], contact: LeaveContact) {
  if (ask === "OFF" || contactProblem(ask, contact) !== null || contact.name.trim() === "") return {};
  return {
    contactName: contact.name.trim(),
    contactPhone: contact.phone.trim(),
    contactRelation: contact.relation.trim(),
  };
}

/** Whether the policy says anything the form must explain or ask. Off as delivered: false. */
export function policyAsks(policy: LeavePolicy | undefined): policy is LeavePolicy {
  return policy !== undefined && (policy.requireAllGuardians || policy.minDaysAhead !== null || policy.contact !== "OFF");
}

/**
 * Whether a request in the family's list has more to say than its plain row: a
 * contact the family wrote, a request that asked for consent, or one ended by
 * a guardian's no. Read defensively: a gateway older than Ledighetspolicy sends
 * none of the fields, and the list then looks as it always did.
 */
export function hasLeaveExtras(leave: Pick<LeaveRequest, "status" | "contact" | "consent">): boolean {
  return (
    leave.status === "GUARDIAN_DECLINED" ||
    (leave.contact ?? null) !== null ||
    (leave.consent?.state ?? "NOT_REQUIRED") !== "NOT_REQUIRED" ||
    (leave.consent?.mine ?? "NOT_ASKED") !== "NOT_ASKED"
  );
}
