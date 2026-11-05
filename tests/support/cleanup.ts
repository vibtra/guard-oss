export type CleanupStep = () => Promise<unknown>;

export interface Cleanup {
  defer(step: CleanupStep): void;
  run(): Promise<void>;
}

export const createCleanup = (): Cleanup => {
  const steps: CleanupStep[] = [];
  return {
    defer: (step) => {
      steps.push(step);
    },
    run: async () => {
      const errors: unknown[] = [];
      for (let step = steps.pop(); step !== undefined; step = steps.pop()) {
        try {
          await step();
        } catch (error) {
          errors.push(error);
        }
      }
      if (errors.length === 1) throw errors[0];
      if (errors.length > 1) throw new AggregateError(errors, "cleanup failed");
    },
  };
};

export const startOrCleanUp = async <T>(cleanup: Cleanup, start: () => Promise<T>): Promise<T> => {
  try {
    return await start();
  } catch (error) {
    try {
      await cleanup.run();
    } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], "start failed and cleanup failed", { cause: cleanupError });
    }
    throw error;
  }
};
