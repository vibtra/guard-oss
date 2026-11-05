import { describe, expect, it } from "vitest";
import { formatElapsed, formatThoughtFor, formatWorkedFor } from "@vibtra/ui/react";

describe("formatElapsed", () => {
  it("prints tenths of a second, then minutes, then hours", () => {
    expect(formatElapsed(100)).toBe("0.1s");
    expect(formatElapsed(36_700)).toBe("36.7s");
    expect(formatElapsed(70_200)).toBe("1m 10.2s");
    expect(formatElapsed(3_725_400)).toBe("1h 2m 5.4s");
  });

  it("floors to the tenth and never rounds up", () => {
    expect(formatElapsed(199)).toBe("0.1s");
    expect(formatElapsed(59_999)).toBe("59.9s");
    expect(formatElapsed(60_000)).toBe("1m 0.0s");
  });

  it("treats zero, a negative and a non-finite value as 0.0s", () => {
    expect(formatElapsed(0)).toBe("0.0s");
    expect(formatElapsed(-5)).toBe("0.0s");
    expect(formatElapsed(Number.NaN)).toBe("0.0s");
    expect(formatElapsed(Number.POSITIVE_INFINITY)).toBe("0.0s");
  });
});

describe("formatWorkedFor and formatThoughtFor", () => {
  it("print the work log pill's words", () => {
    expect(formatWorkedFor(160_400)).toBe("Worked for 2m 40s");
    expect(formatWorkedFor(12_900)).toBe("Worked for 12s");
    expect(formatWorkedFor(3_780_000)).toBe("Worked for 1h 3m");
    expect(formatThoughtFor(800)).toBe("Thought for 1 second");
    expect(formatThoughtFor(2_600)).toBe("Thought for 3 seconds");
  });
});
