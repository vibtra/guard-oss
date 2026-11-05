export interface Clock {
  now(): Date;
}

export interface TestClock extends Clock {
  advance(ms: number): Date;
  set(at: Date): Date;
}

export const systemClock = (): Clock => ({ now: () => new Date() });

export const createTestClock = (start: Date = new Date(), realNow: () => number = () => Date.now()): TestClock => {
  const origin = realNow();
  let offset = start.getTime() - origin;
  return {
    now: () => new Date(realNow() + offset),
    advance(ms: number) {
      if (!Number.isFinite(ms) || ms < 0 || ms > 400 * 24 * 3_600_000) throw new RangeError("advance takes 0 to 400 days in milliseconds");
      offset += ms;
      return new Date(realNow() + offset);
    },
    set(at: Date) {
      const target = at.getTime() - realNow();
      if (target < offset) throw new RangeError("a test clock never moves back");
      offset = target;
      return new Date(realNow() + offset);
    },
  };
};

export const testClockEnabled = (env: NodeJS.ProcessEnv): boolean => {
  if ((env.VIBTRA_TEST_CLOCK ?? "").trim() !== "1") return false;
  if (env.NODE_ENV === "production") throw new Error("VIBTRA_TEST_CLOCK is a test switch and is refused when NODE_ENV is production");
  return true;
};
