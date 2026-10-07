/*
 * The timetable's lesson dialogs, fetched as ONE chunk: Lägg till, Justera,
 * Publicera and the two questions after a drag.
 *
 * One module rather than one import() each, because of how Turbopack builds
 * an on-demand chunk: it leaves out only what the page that loads it already
 * carries, and copies everything else in. Once the page stopped carrying
 * @radix-ui/react-dialog, the Switch and the date picker (none of which the
 * grid draws on load), every dialog fetched on its own would bring its own
 * copy of them — five copies of the same 3-4 KB. Fetched together they share
 * one. The page starts this fetch right after it mounts, since Justera and
 * Lägg till are the dialogs a school opens all day.
 *
 * Versioner and Optimera salar stay separate imports in the page: they are
 * pressed a few times a term, and fetching them with these would load them on
 * every visit.
 *
 * The two free-time searches ride along for the same reason: a refused drop
 * opens the suggestions and the slot finder fills Lägg till, so the page awaits
 * them from here, where they are usually already loaded, instead of carrying
 * them in its first load or fetching a second chunk.
 */

export { CreateLessonDialog } from "@/components/schedule/create-lesson-dialog";
export { LessonEditDialog } from "@/components/schedule/lesson-edit-dialog";
export { PublishDialog } from "@/components/schedule/publish-dialog";
export {
  SharedMoveDialog,
  SuggestPlacementsDialog,
} from "@/components/schedule/placement-dialogs";
export { findOpenSlots, suggestPlacements } from "@/lib/placement-search";
