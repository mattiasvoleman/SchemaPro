/**
 * The room types a new Swedish school starts with.
 *
 * Room types are school-owned rows, so this list is only a starting point: a
 * school adds, renames and removes freely. It exists because a brand-new
 * school would otherwise open "Kom igång → Salar" with an empty type picker
 * and no idea what to type.
 *
 * Kept in one place so the seed, the deployment bootstrap and any future
 * school-creation flow cannot drift apart.
 */
export const DEFAULT_ROOM_TYPES = [
  'Klassrum',
  'Laborationssal',
  'Gymnastiksal',
  'Hemkunskapssal',
  'Trä- och metallslöjd',
  'Textilslöjd',
  'Musiksal',
  'Bildsal',
  'Aula',
  'Övrigt',
] as const;
