/** Running out of memory replaces the engine and says why in plain words. */
import { describe, expect, it } from "vitest";
import { describeError, isFatalError, TOO_LARGE } from "../../src/engine/engine";

describe("out of memory", () => {
  it.each([
    "realloc (367746783 bytes) failed",
    "malloc (1024 bytes) failed",
    "calloc of array (9 x 9 bytes) failed",
    "Array buffer allocation failed",
  ])("treats %s as fatal with a clear message", (text) => {
    expect(isFatalError(new Error(text))).toBe(true);
    expect(describeError(new Error(text))).toBe(TOO_LARGE);
  });

  it("leaves ordinary errors alone", () => {
    expect(isFatalError(new Error("No pages selected"))).toBe(false);
  });
});
