/**
 * A timplanspost by the name the Timplan page gives its cell
 * (`requirements.cellLabel`, "{subject} för {group}"), or the subject alone
 * when the group has none. One function for every refusal that names a row,
 * the engine's and the staffing pre-flight's alike.
 *
 * Its own file, and not the proxy's: MasterLessonsService needs it, and the
 * proxy needs MasterLessonsService (the judge of a förläggning). With the
 * function in the proxy the two files imported each other, and whichever was
 * read first saw the other half-built: the proxy's constructor was decorated
 * with `undefined` where MasterLessonsService stood, and Nest injected
 * nothing (review of #293, HÖG-1). requirement-name.spec.ts keeps the cycle
 * from coming back.
 */
export function requirementName(subject: string, group: string | undefined | null): string {
  return group ? `${subject} för ${group}` : subject;
}
