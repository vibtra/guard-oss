import { VibtraError } from "../errors.js";

export const assertTestAuthIsPermitted = (env: NodeJS.ProcessEnv): void => {
  if ((env.REGISTRY_TEST_AUTH ?? "") !== "1") return;
  if (env.NODE_ENV === "production") {
    throw new VibtraError({
      code: "VALIDATION",
      message: "REGISTRY_TEST_AUTH cannot be set on a production registry",
      detail:
        "REGISTRY_TEST_AUTH=1 enables email+password sign-in for the test suites and `pnpm e2e:proof`. It is a " +
        "password door on a multi-tenant registry, and NODE_ENV=production refuses it rather than serving it. " +
        "Unset one of the two.",
    });
  }
};

export const testAuthEnabled = (env: NodeJS.ProcessEnv): boolean => {
  assertTestAuthIsPermitted(env);
  return (env.REGISTRY_TEST_AUTH ?? "") === "1";
};
