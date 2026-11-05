import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const SCRIPT = fileURLToPath(new URL("../../../scripts/check-mac-test-targets.mjs", import.meta.url));
const PROJECT = "guard/mac/VibtraGuard.xcodeproj/project.pbxproj";
const SCHEMES = "guard/mac/VibtraGuard.xcodeproj/xcshareddata/xcschemes" as const;
const APP_SCHEME = `${SCHEMES}/VibtraGuard.xcscheme` as const;
const TESTS_SCHEME = `${SCHEMES}/VibtraGuardIntegrationTests.xcscheme` as const;
type Scheme = typeof APP_SCHEME | typeof TESTS_SCHEME;
const committed = (file: string): string => readFileSync(fileURLToPath(new URL(`../../../${file}`, import.meta.url)), "utf8");
const COMMITTED_SCHEMES: Record<Scheme, string> = { [APP_SCHEME]: committed(APP_SCHEME), [TESTS_SCHEME]: committed(TESTS_SCHEME) };
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const target = (id: string, name: string, productType: string): string => `\t\t${id} /* ${name} */ = {
\t\t\tisa = PBXNativeTarget;
\t\t\tbuildPhases = (
\t\t\t\t${id.replace(/^0B/, "0D")} /* Sources */,
\t\t\t);
\t\t\tname = ${name};
\t\t\tproductName = ${name};
\t\t\tproductType = "${productType}";
\t\t};
`;

const pbxproj = (extraTargets: string): string => `// !$*UTF8*$!
{
\tarchiveVersion = 1;
\tclasses = {
\t};
\tobjectVersion = 77;
\tobjects = {

/* Begin PBXFileReference section */
\t\t0A0000000000000000000001 /* MadeUp.swift */ = {isa = PBXFileReference; lastKnownFileType = sourcecode.swift; path = "Made \\"Up\\".swift"; sourceTree = "<group>"; };
/* End PBXFileReference section */

/* Begin PBXNativeTarget section */
${target("0B0000000000000000000001", "MadeUpApp", "com.apple.product-type.application")}${target("0B0000000000000000000002", "VibtraGuardIntegrationTests", "com.apple.product-type.bundle.unit-test")}${extraTargets}/* End PBXNativeTarget section */
\t};
\trootObject = 0C0000000000000000000001 /* Project object */;
}
`;

const testable = (blueprintIdentifier: string, buildableName: string, blueprintName: string, container: string): string => `         <TestableReference
            skipped = "NO"
            parallelizable = "NO">
            <BuildableReference
               BuildableIdentifier = "primary"
               BlueprintIdentifier = "${blueprintIdentifier}"
               BuildableName = "${buildableName}"
               BlueprintName = "${blueprintName}"
               ReferencedContainer = "${container}">
            </BuildableReference>
         </TestableReference>
`;

const XCODEGEN_PACKAGE_TESTABLE = testable("MadeUpPkgTests", "MadeUpPkgTests", "MadeUpPkgTests", "container:MadeUpPkg");
const XCODEGEN_OTHER_PROJECT_TESTABLE = testable("6D8052ADF334536E2CEE2C65", "VibtraGuardIntegrationTests.xctest", "VibtraGuardIntegrationTests", "container:MadeUpOther/MadeUpOther.xcodeproj");
const XCODEGEN_TEST_PLAN = `      <TestPlans>
         <TestPlanReference
            default = "YES"
            reference = "container:MadeUp.xctestplan">
         </TestPlanReference>
      </TestPlans>
`;

const addTestable = (scheme: string, extra: string): string => scheme.replace("      </Testables>\n", `${extra}      </Testables>\n`);

const XCODEGEN_PRE_ACTION = `      <PreActions>
         <ExecutionAction
            ActionType = "Xcode.IDEStandardExecutionActionsCore.ExecutionActionType.ShellScriptAction">
            <ActionContent
               title = "Made-up unit tests"
               scriptText = "swift test --package-path &quot;$SRCROOT/MadeUpPkg&quot;">
            </ActionContent>
         </ExecutionAction>
      </PreActions>
`;
const USER_SCHEME = "guard/mac/VibtraGuard.xcodeproj/xcuserdata/runner.xcuserdatad/xcschemes/VibtraGuardIntegrationTests.xcscheme";
const WORKSPACE_SCHEME = "guard/mac/VibtraGuard.xcodeproj/project.xcworkspace/xcshareddata/xcschemes/MadeUpTests.xcscheme";

const check = async (text: string, schemes: Record<string, string> = COMMITTED_SCHEMES) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "mac-test-targets-"));
  roots.push(root);
  await mkdir(path.join(root, SCHEMES), { recursive: true });
  await writeFile(path.join(root, PROJECT), text);
  for (const [file, scheme] of Object.entries(schemes)) {
    await mkdir(path.dirname(path.join(root, file)), { recursive: true });
    await writeFile(path.join(root, file), scheme);
  }
  return spawnSync(process.execPath, [SCRIPT, root], { encoding: "utf8" });
};

const schemeRefusal = (scheme: string, what: string): string =>
  `test-locations: ${scheme}: ${what}. VibtraGuardIntegrationTests is the only Mac test target. Put new Mac tests in tests/mac/ or in VibtraGuardIntegrationTests.`;

const strayRefusal = (scheme: string, what = "a committed user or workspace scheme"): string =>
  schemeRefusal(scheme, `${what}. Only schemes directly in ${SCHEMES} may be committed`);

const nonAsciiRefusal = (file: string): string =>
  schemeRefusal(file, "a path with a non-ASCII character, which macOS may read as an ASCII path. Only ASCII paths may be committed in guard/mac/VibtraGuard.xcodeproj");

const refusal = (name: string, productType: string): string =>
  `test-locations: ${PROJECT}: target ${name} has the test product type ${productType}. VibtraGuardIntegrationTests is the only Mac test target. Put new Mac tests in tests/mac/ or in VibtraGuardIntegrationTests.`;

describe("check-mac-test-targets", () => {
  it("passes the committed project", () => {
    const result = spawnSync(process.execPath, [SCRIPT], { encoding: "utf8" });
    expect([result.status, result.stderr]).toEqual([0, ""]);
  });

  it("passes a project whose only test target is VibtraGuardIntegrationTests", async () => {
    const result = await check(pbxproj(""));
    expect([result.status, result.stderr]).toEqual([0, ""]);
  });

  it.each(["com.apple.product-type.bundle.unit-test", "com.apple.product-type.bundle.ocunit-test", "com.apple.product-type.bundle.ui-testing"])(
    "fails on a second target of type %s",
    async (productType) => {
      const result = await check(pbxproj(target("0B0000000000000000000003", "MadeUpTests", productType)));
      expect([result.status, result.stderr.trim()]).toEqual([1, refusal("MadeUpTests", productType)]);
    },
  );

  it("names every extra test target", async () => {
    const result = await check(pbxproj(`${target("0B0000000000000000000003", "MadeUpUITests", "com.apple.product-type.bundle.ui-testing")}${target("0B0000000000000000000004", "MadeUpTests", "com.apple.product-type.bundle.unit-test")}`));
    expect([result.status, result.stderr.trim().split("\n")]).toEqual([
      1,
      [refusal("MadeUpTests", "com.apple.product-type.bundle.unit-test"), refusal("MadeUpUITests", "com.apple.product-type.bundle.ui-testing")],
    ]);
  });

  it.each([
    ["a Swift package test target in the integration scheme", TESTS_SCHEME, XCODEGEN_PACKAGE_TESTABLE, "the scheme tests MadeUpPkgTests (MadeUpPkgTests) in container:MadeUpPkg"],
    ["a Swift package test target in the app scheme", APP_SCHEME, XCODEGEN_PACKAGE_TESTABLE, "the scheme tests MadeUpPkgTests (MadeUpPkgTests) in container:MadeUpPkg"],
    [
      "a same-named test target from another project",
      TESTS_SCHEME,
      XCODEGEN_OTHER_PROJECT_TESTABLE,
      "the scheme tests VibtraGuardIntegrationTests (VibtraGuardIntegrationTests.xctest) in container:MadeUpOther/MadeUpOther.xcodeproj",
    ],
    [
      "a hand-edited BlueprintName",
      TESTS_SCHEME,
      testable("C3C3CDE8BB452DE54684556E", "VibtraGuardIntegrationTests.xctest", "MadeUpTests", "container:VibtraGuard.xcodeproj"),
      "the scheme tests MadeUpTests (VibtraGuardIntegrationTests.xctest) in container:VibtraGuard.xcodeproj",
    ],
    [
      "a hand-edited BuildableName",
      TESTS_SCHEME,
      testable("C3C3CDE8BB452DE54684556E", "MadeUpTests.xctest", "VibtraGuardIntegrationTests", "container:VibtraGuard.xcodeproj"),
      "the scheme tests VibtraGuardIntegrationTests (MadeUpTests.xctest) in container:VibtraGuard.xcodeproj",
    ],
  ])("fails on %s", async (_case, scheme: Scheme, extra, what) => {
    const result = await check(pbxproj(""), { ...COMMITTED_SCHEMES, [scheme]: addTestable(COMMITTED_SCHEMES[scheme], extra) });
    expect([result.status, result.stderr.trim()]).toEqual([1, schemeRefusal(scheme, what)]);
  });

  it("fails on a test plan, whose targets live outside the project", async () => {
    const scheme = COMMITTED_SCHEMES[TESTS_SCHEME].replace(/      <Testables>[\s\S]*<\/Testables>\n/, "      <Testables>\n      </Testables>\n").replace("      <MacroExpansion>\n", `${XCODEGEN_TEST_PLAN}      <MacroExpansion>\n`);
    const result = await check(pbxproj(""), { ...COMMITTED_SCHEMES, [TESTS_SCHEME]: scheme });
    expect([result.status, result.stderr.trim()]).toEqual([
      1,
      schemeRefusal(TESTS_SCHEME, "the scheme runs the test plan container:MadeUp.xctestplan, which lists its tests outside the project"),
    ]);
  });

  it.each(["PreActions", "PostActions"])("fails on test-action %s", async (tag) => {
    const scheme = COMMITTED_SCHEMES[TESTS_SCHEME].replace("      <MacroExpansion>\n", `${XCODEGEN_PRE_ACTION.replaceAll("PreActions", tag)}      <MacroExpansion>\n`);
    const result = await check(pbxproj(""), { ...COMMITTED_SCHEMES, [TESTS_SCHEME]: scheme });
    expect([result.status, result.stderr.trim()]).toEqual([1, schemeRefusal(TESTS_SCHEME, `the scheme has ${tag}, a script Xcode runs around an action. Schemes may not run scripts`)]);
  });

  it("fails when the integration scheme is not shared", async () => {
    const result = await check(pbxproj(""), { [APP_SCHEME]: COMMITTED_SCHEMES[APP_SCHEME] });
    expect([result.status, result.stderr.trim()]).toEqual([
      1,
      `test-locations: ${TESTS_SCHEME} is missing. tests/mac/run.sh runs that shared scheme. VibtraGuardIntegrationTests is the only Mac test target. Put new Mac tests in tests/mac/ or in VibtraGuardIntegrationTests.`,
    ]);
  });

  it.each([
    ["a user scheme", USER_SCHEME],
    ["a workspace scheme", WORKSPACE_SCHEME],
    ["a user scheme in XCUserData", "guard/mac/VibtraGuard.xcodeproj/XCUserData/runner.xcuserdatad/xcschemes/VibtraGuardIntegrationTests.xcscheme"],
    ["a user scheme ending in .XCSCHEME", "guard/mac/VibtraGuard.xcodeproj/xcuserdata/runner.xcuserdatad/xcschemes/VibtraGuardIntegrationTests.XCSCHEME"],
    ["a workspace scheme in Project.XCWorkspace", "guard/mac/VibtraGuard.xcodeproj/Project.XCWorkspace/xcshareddata/xcschemes/MadeUpTests.xcscheme"],
  ])("fails on %s committed outside xcshareddata/xcschemes", async (_case, file) => {
    const result = await check(pbxproj(""), { ...COMMITTED_SCHEMES, [file]: addTestable(COMMITTED_SCHEMES[TESTS_SCHEME], XCODEGEN_PACKAGE_TESTABLE) });
    expect([result.status, result.stderr.trim()]).toEqual([1, strayRefusal(file)]);
  });

  it("fails on a scheme in a folder inside xcshareddata/xcschemes", async () => {
    const file = `${SCHEMES}/MadeUp/MadeUpTests.xcscheme`;
    const result = await check(pbxproj(""), { ...COMMITTED_SCHEMES, [file]: addTestable(COMMITTED_SCHEMES[TESTS_SCHEME], XCODEGEN_PACKAGE_TESTABLE) });
    expect([result.status, result.stderr.trim()]).toEqual([1, strayRefusal(file, "a committed scheme outside the shared scheme folder")]);
  });

  it("fails on a user scheme in a case variant of the project folder, which macOS reads as the same folder", async () => {
    const file = "Guard/Mac/vibtraguard.xcodeproj/xcuserdata/runner.xcuserdatad/xcschemes/VibtraGuardIntegrationTests.xcscheme";
    const result = await check(pbxproj(""), { ...COMMITTED_SCHEMES, [file]: addTestable(COMMITTED_SCHEMES[TESTS_SCHEME], XCODEGEN_PACKAGE_TESTABLE) });
    expect([result.status, result.stderr.trim().toLowerCase()]).toEqual([1, strayRefusal(file).toLowerCase()]);
  });

  it("fails on a shared scheme ending in .xcſcheme, which macOS reads as .xcscheme", async () => {
    const file = `${SCHEMES}/MadeUpTests.xcſcheme`;
    const result = await check(pbxproj(""), { ...COMMITTED_SCHEMES, [file]: addTestable(COMMITTED_SCHEMES[TESTS_SCHEME], XCODEGEN_PACKAGE_TESTABLE) });
    expect([result.status, result.stderr.trim().split("\n")]).toEqual([1, [nonAsciiRefusal(file), schemeRefusal(file, "the scheme tests MadeUpPkgTests (MadeUpPkgTests) in container:MadeUpPkg")]]);
  });

  it("fails on a user scheme ending in .xcſcheme in a case variant of the project folder", async () => {
    const file = "guard/mac/vibtraguard.xcodeproj/xcuserdata/runner.xcuserdatad/xcschemes/MadeUpTests.xcſcheme";
    const result = await check(pbxproj(""), { ...COMMITTED_SCHEMES, [file]: addTestable(COMMITTED_SCHEMES[TESTS_SCHEME], XCODEGEN_PACKAGE_TESTABLE) });
    expect([result.status, result.stderr.trim().toLowerCase().split("\n")]).toEqual([1, [strayRefusal(file).toLowerCase(), nonAsciiRefusal(file).toLowerCase()]]);
  });

  it.each([
    ["a user scheme in xcuſerdata", "guard/mac/VibtraGuard.xcodeproj/xcuſerdata/runner.xcuserdatad/xcschemes/VibtraGuardIntegrationTests.xcscheme", [strayRefusal]],
    ["a file in a folder named MadeUpø", "guard/mac/VibtraGuard.xcodeproj/MadeUpø/MadeUp.plist", []],
  ])("fails on %s, a non-ASCII folder name", async (_case, file, others: ((file: string) => string)[]) => {
    const result = await check(pbxproj(""), { ...COMMITTED_SCHEMES, [file]: addTestable(COMMITTED_SCHEMES[TESTS_SCHEME], XCODEGEN_PACKAGE_TESTABLE) });
    expect([result.status, result.stderr.trim().split("\n")]).toEqual([1, [...others.map((other) => other(file)), nonAsciiRefusal(file)]]);
  });

  it("names both errors when the integration scheme moves to xcuserdata", async () => {
    const result = await check(pbxproj(""), { [APP_SCHEME]: COMMITTED_SCHEMES[APP_SCHEME], [USER_SCHEME]: addTestable(COMMITTED_SCHEMES[TESTS_SCHEME], XCODEGEN_PACKAGE_TESTABLE) });
    expect([result.status, result.stderr.trim().split("\n")]).toEqual([
      1,
      [
        `test-locations: ${TESTS_SCHEME} is missing. tests/mac/run.sh runs that shared scheme. VibtraGuardIntegrationTests is the only Mac test target. Put new Mac tests in tests/mac/ or in VibtraGuardIntegrationTests.`,
        strayRefusal(USER_SCHEME),
      ],
    ]);
  });

  it("passes a testable that only a comment adds", async () => {
    const result = await check(pbxproj(""), { ...COMMITTED_SCHEMES, [TESTS_SCHEME]: addTestable(COMMITTED_SCHEMES[TESTS_SCHEME], `<!--\n${XCODEGEN_PACKAGE_TESTABLE}-->\n`) });
    expect([result.status, result.stderr]).toEqual([0, ""]);
  });

  it.each([
    ["a truncated project", pbxproj("").slice(0, -3), "unexpected end of file"],
    ["a duplicate object id", pbxproj(target("0B0000000000000000000001", "MadeUpTests", "com.apple.product-type.bundle.unit-test")), "duplicate key 0B0000000000000000000001"],
    ["a second project after the first", `${pbxproj("")}${pbxproj(target("0B0000000000000000000003", "MadeUpTests", "com.apple.product-type.bundle.unit-test"))}`, "trailing text"],
    ["a project with no native target", pbxproj("").replace(/\/\* Begin PBXNativeTarget[\s\S]*End PBXNativeTarget section \*\/\n/, ""), "no PBXNativeTarget"],
    ["a truncated scheme", pbxproj(""), "unexpected end of file", { ...COMMITTED_SCHEMES, [TESTS_SCHEME]: COMMITTED_SCHEMES[TESTS_SCHEME].replace("</Scheme>\n", "") }],
    ["a mismatched close tag", pbxproj(""), "expected </Testables>", { ...COMMITTED_SCHEMES, [TESTS_SCHEME]: COMMITTED_SCHEMES[TESTS_SCHEME].replace("      </Testables>", "      </TestAction>") }],
    ["an unknown entity", pbxproj(""), "unknown entity", { ...COMMITTED_SCHEMES, [TESTS_SCHEME]: COMMITTED_SCHEMES[TESTS_SCHEME].replace('BlueprintName = "VibtraGuardIntegrationTests"', 'BlueprintName = "&madeup;"') }],
    ["a second root after the scheme", pbxproj(""), "trailing text", { ...COMMITTED_SCHEMES, [TESTS_SCHEME]: `${COMMITTED_SCHEMES[TESTS_SCHEME]}<Scheme/>\n` }],
    ["a root element other than Scheme", pbxproj(""), "the root element is MadeUp, not Scheme", { ...COMMITTED_SCHEMES, [TESTS_SCHEME]: COMMITTED_SCHEMES[TESTS_SCHEME].replace("<Scheme\n", "<MadeUp\n").replace("</Scheme>\n", "</MadeUp>\n") }],
    [
      "a duplicate attribute",
      pbxproj(""),
      "duplicate attribute BlueprintName",
      { ...COMMITTED_SCHEMES, [TESTS_SCHEME]: COMMITTED_SCHEMES[TESTS_SCHEME].replace('BlueprintName = "VibtraGuardIntegrationTests"', 'BlueprintName = "MadeUpTests"\n               BlueprintName = "VibtraGuardIntegrationTests"') },
    ],
    ["no shared scheme", pbxproj(""), "is missing", {}],
  ])("fails closed on %s", async (_case, text, reason, schemes?: Record<string, string>) => {
    const result = await check(text, schemes);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(reason);
  });
});
