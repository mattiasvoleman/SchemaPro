import { describe, expect, it } from "vitest";
import fixture from "../../src/import/__fixtures__/csv-cell-rules.json";
import { isEmailAddress, isHexColor, textLength } from "@/lib/csv-cell-rules";

/**
 * The copies of @IsEmail(), @IsHexColor() and @MaxLength() against the cases
 * src/import/csv-cell-rules.contract.spec.ts proves class-validator answers
 * the same way. A drift either refuses a file the gateway would take or lets
 * its whole-file 400 back in.
 */
describe("the import cell rules agree with the gateway's", () => {
  it.each(fixture.emails.map((c) => [c.value, c.valid] as const))("isEmailAddress(%j) is %s", (value, valid) => {
    expect(isEmailAddress(value)).toBe(valid);
  });

  it.each(fixture.hexColors.map((c) => [c.value, c.valid] as const))("isHexColor(%j) is %s", (value, valid) => {
    expect(isHexColor(value)).toBe(valid);
  });

  it.each(fixture.lengths.map((c) => [c.value, c.length] as const))("textLength(%j) is %i", (value, length) => {
    expect(textLength(value)).toBe(length);
  });
});
