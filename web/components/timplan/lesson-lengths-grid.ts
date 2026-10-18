/**
 * The grid an extra length's row uses, and the cell dialog's first pair while
 * extra rows exist (components/timplan/lesson-lengths-fields.tsx). Its own
 * module so the requirements page can draw the first pair without loading
 * the fields, which it fetches with the dialog.
 */
export const EXTRA_ROW_GRID = "grid grid-cols-[1fr_1fr_2.25rem] items-end gap-4";
