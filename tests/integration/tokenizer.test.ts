import { describe, expect, it } from "vitest";
import { encodeLatin1, parseContent } from "../../src/engine/content/tokenizer";

describe("content tokenizer", () => {
  it("survives absurdly nested arrays and dictionaries", () => {
    const deep = "[".repeat(50_000) + "]".repeat(50_000) + " TJ " + "<<".repeat(50_000) + "" + ">>".repeat(50_000) + " BDC (ok) Tj";
    const ops = parseContent(encodeLatin1(deep));
    expect(ops.at(-1)?.op).toBe("Tj");
  });
});
