/*
 * What a week picked needs, fetched together after the page is up (lib/use-lazy-module.ts): the weeks of the läsår, the nearest week of a
 * parity, the dates under the days, the narrowing of the cards and what a card says of its weeks. The picker itself (components/placements/week-picker.tsx) imports the
 * same modules, so the one chunk serves both. The route has no bytes to spare for any of it (memory bundle-gate-measurement).
 */
export { datesOfWeek, nearestWeekOf, weeksOfYear } from "@/lib/placement-weeks";
export { narrowToWeek } from "@/lib/placement-week-view";
export { weekNote } from "@/lib/placement-week-note";
