import type { TransformFnParams } from 'class-transformer';

/**
 * Text the way the table reads it: the CHECK on every name, title and contact counts the characters of
 * btrim(value), so the length rules (@MinLength and @MaxLength) must count the trimmed text too. Without this the
 * pipe lets "   " through as three characters, the service trims it to nothing, and the database answers with a
 * 23514 that reaches the client as a 500. Place it above the length decorators; null and undefined pass.
 */
export const trimmed = ({ value }: TransformFnParams): unknown => (typeof value === 'string' ? value.trim() : value);
