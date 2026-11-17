import { describe, expect, it } from "vitest";
import { canonicalJson } from "@vibtra/guard-contract";

describe("canonicalJson", () => {
  it("writes null, including null values inside objects and arrays", () => {
    expect(canonicalJson(null)).toBe("null");
    expect(canonicalJson({ b: null, a: [null, 1] })).toBe('{"a":[null,1],"b":null}');
  });

  it("sorts keys at every depth and drops undefined values", () => {
    expect(canonicalJson({ z: { y: 1, x: [{ b: "2", a: true }] }, a: undefined, m: "made-up" })).toBe('{"m":"made-up","z":{"x":[{"a":true,"b":"2"}],"y":1}}');
  });

  it("refuses a number that is not an integer", () => {
    expect(() => canonicalJson({ ratio: 0.5 })).toThrow("canonicalJson: a signed Guard document carries integers only");
  });
});
