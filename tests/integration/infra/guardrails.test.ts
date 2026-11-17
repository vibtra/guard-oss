import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { defineRegistryApp } from "@vibtra/infra/lib/app.ts";
import { applyNagChecks, kmsPolicyFindings, readNagSuppressions, type NagSuppression } from "@vibtra/infra/lib/guardrails.ts";
import { App, Stack } from "aws-cdk-lib";
import * as iam from "aws-cdk-lib/aws-iam";
import * as kms from "aws-cdk-lib/aws-kms";
import * as s3 from "aws-cdk-lib/aws-s3";
import { afterEach, describe, expect, it } from "vitest";
import { infraDir, runCdkApp } from "./synth.js";

type Report = { pluginReports: Array<{ violations: Array<{ ruleName: string; violatingConstructs: Array<{ constructPath: string }> }> }> };

const dirs: string[] = [];

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

const outdir = async (): Promise<string> => {
  const dir = await mkdtemp(join(tmpdir(), "vibtra-guardrails-"));
  dirs.push(dir);
  return dir;
};

const cdkContext = async (): Promise<Record<string, unknown>> =>
  (JSON.parse(await readFile(join(infraDir, "cdk.json"), "utf8")) as { context: Record<string, unknown> }).context;

const findingsOf = async (app: App, dir: string): Promise<string[]> => {
  try {
    app.synth();
    return [];
  } catch (error) {
    expect(String(error)).toContain("A copy of this report can be found in");
  }
  const report = JSON.parse(await readFile(join(dir, "validation-report.json"), "utf8")) as Report;
  const found = report.pluginReports.flatMap((plugin) => plugin.violations.flatMap((violation) => violation.violatingConstructs.map((construct) => `${construct.constructPath} ${violation.ruleName}`)));
  return [...new Set(found)].sort();
};

const fixtureStack = (dir: string, build: (stack: Stack) => void, suppressions: readonly NagSuppression[] = []): App => {
  const app = new App({ outdir: dir });
  build(new Stack(app, "Fixture"));
  applyNagChecks(app, suppressions);
  return app;
};

const keyRole = (stack: Stack, statement: iam.PolicyStatement) => {
  const role = new iam.Role(stack, "KeyRole", { assumedBy: new iam.ServicePrincipal("ecs-tasks.amazonaws.com") });
  role.addToPolicy(statement);
};

describe("infra guardrails: cdk-nag and the KMS IAM rules run on every synth", () => {
  it("the real app synthesises clean: every cdk-nag finding today is in infra/nag-suppressions.json, and no KMS statement breaks the rules", async () => {
    const run = await runCdkApp();
    expect([run.status, run.stderr]).toEqual([0, ""]);
  });

  it("every suppression matches a finding the real app still has, and every finding has a suppression", async () => {
    const dir = await outdir();
    const unsuppressed = await findingsOf(defineRegistryApp(new App({ outdir: dir, context: await cdkContext() }), []), dir);
    expect(unsuppressed).toEqual(readNagSuppressions().map((row) => `${row.path} ${row.id}`).sort());
  });

  it("every suppression carries a reason", () => {
    for (const row of readNagSuppressions()) expect(row.reason.trim().length, `${row.path} ${row.id}`).toBeGreaterThanOrEqual(20);
  });

  it("refuses a suppression with no reason and says what to write", async () => {
    const dir = await outdir();
    const file = join(dir, "nag-suppressions.json");
    await writeFile(file, JSON.stringify({ suppressions: [{ path: "Fixture/Bucket/Resource", id: "AwsSolutions-S1", reason: "" }] }));
    expect(() => readNagSuppressions(pathToFileURL(file))).toThrow(
      "infra/nag-suppressions.json: the AwsSolutions-S1 suppression on Fixture/Bucket/Resource has no reason. Write why the finding is safe",
    );
  });

  it("fails the synth on a new cdk-nag finding, and passes once that finding is suppressed with a reason", async () => {
    const bucket = (stack: Stack) => new s3.Bucket(stack, "Bucket");
    const dir = await outdir();
    const findings = await findingsOf(fixtureStack(dir, bucket), dir);
    expect(findings.length).toBeGreaterThan(0);
    expect(findings.every((finding) => finding.startsWith("Fixture/") && finding.includes(" AwsSolutions-"))).toBe(true);
    const suppressed = await outdir();
    const rows = findings.map((finding) => {
      const [path = "", id = ""] = finding.split(" ");
      return { path, id, reason: "fixture: accepted for this test only" };
    });
    expect(await findingsOf(fixtureStack(suppressed, bucket, rows), suppressed)).toEqual([]);
  });

  it("fails the synth on kms:* over Resource * without kms:KeySpec and kms:KeyUsage, and on kms:TagResource without aws:RequestTag", async () => {
    const dir = await outdir();
    const app = fixtureStack(dir, (stack) => keyRole(stack, new iam.PolicyStatement({ actions: ["kms:CreateKey", "kms:TagResource"], resources: ["*"] })));
    const findings = (await findingsOf(app, dir)).filter((finding) => finding.includes(" kms-"));
    expect(findings).toEqual(["Fixture/KeyRole/DefaultPolicy/Resource kms-tag-resource", "Fixture/KeyRole/DefaultPolicy/Resource kms-wildcard-resource"]);
  });

  it("passes kms statements that carry the conditions", () => {
    const template = {
      Resources: {
        Policy: {
          Type: "AWS::IAM::Policy",
          Properties: {
            PolicyDocument: {
              Statement: [
                { Effect: "Allow", Action: "kms:CreateKey", Resource: "*", Condition: { StringEquals: { "kms:KeySpec": "ECC_NIST_P256", "kms:KeyUsage": "SIGN_VERIFY" } } },
                {
                  Effect: "Allow",
                  Action: "kms:TagResource",
                  Resource: "arn:aws:kms:ap-southeast-2:123456789012:key/*",
                  Condition: { StringEquals: { "aws:RequestTag/vibtra:org": "o1", "kms:KeySpec": "ECC_NIST_P256", "kms:KeyUsage": "SIGN_VERIFY" } },
                },
                { Effect: "Allow", Action: ["kms:Sign"], Resource: "arn:aws:kms:ap-southeast-2:123456789012:key/abc" },
                { Effect: "Deny", Action: "kms:*", Resource: "*" },
              ],
            },
          },
        },
      },
    };
    expect(kmsPolicyFindings(template)).toEqual([]);
  });

  it("names the statement and says what to do instead", () => {
    const findings = kmsPolicyFindings({
      Resources: {
        Role: { Type: "AWS::IAM::Role", Properties: { Policies: [{ PolicyDocument: { Statement: [{ Effect: "Allow", Action: "kms:*", Resource: ["*"] }] } }] } },
        Key: { Type: "AWS::KMS::Key", Properties: { KeyPolicy: { Statement: { Effect: "Allow", Action: "*", Resource: "*" } } } },
      },
    });
    expect(findings.map((finding) => `${finding.logicalId} ${finding.rule}`)).toEqual([
      "Role kms-wildcard-resource",
      "Role kms-tag-resource",
      "Key kms-wildcard-resource",
      "Key kms-tag-resource",
    ]);
    expect(findings[0]?.problem).toBe(
      'allows kms:* on "*" without kms:KeySpec and kms:KeyUsage conditions. Scope the statement to the key ARNs it needs, or add both conditions so it reaches only the key type the registry uses.',
    );
    expect(findings[1]?.problem).toContain("Add a StringEquals aws:RequestTag/<key> condition");
  });

  it("S3: treats key/* and alias/* resources as wildcards, plain or through Fn::Join, and Allow with NotAction as granting kms:*", () => {
    const join = (tail: string) => ({ "Fn::Join": ["", ["arn:", { Ref: "AWS::Partition" }, ":kms:", { Ref: "AWS::Region" }, ":", { Ref: "AWS::AccountId" }, tail]] });
    const statements = [
      { Effect: "Allow", Action: "kms:Sign", Resource: "arn:aws:kms:ap-southeast-2:123456789012:key/*" },
      { Effect: "Allow", Action: ["kms:Sign"], Resource: [join(":alias/*")] },
      { Effect: "Allow", Action: "kms:DescribeKey", Resource: join(":key/*") },
      { Effect: "Allow", NotAction: "iam:*", Resource: "arn:aws:kms:ap-southeast-2:123456789012:key/abc" },
      { Effect: "Allow", NotAction: ["kms:*"], Resource: "*" },
    ];
    const findings = kmsPolicyFindings({ Resources: Object.fromEntries(statements.map((statement, index) => [`P${index}`, { Type: "AWS::IAM::Policy", Properties: { PolicyDocument: { Statement: statement } } }])) });
    expect(findings.map((finding) => `${finding.logicalId} ${finding.rule}`)).toEqual(["P0 kms-wildcard-resource", "P1 kms-wildcard-resource", "P2 kms-wildcard-resource", "P3 kms-tag-resource"]);
    expect(findings[1]?.problem).toContain('on "arn:${token}:kms:${token}:${token}:alias/*"');
  });

  it("S3: kms:TagResource needs StringEquals on aws:RequestTag/<key> with a value that is not a wildcard", () => {
    const tagging = (condition: Record<string, Record<string, unknown>>) => ({
      Resources: {
        P: {
          Type: "AWS::IAM::Policy",
          Properties: { PolicyDocument: { Statement: { Effect: "Allow", Action: "kms:TagResource", Resource: "arn:aws:kms:ap-southeast-2:123456789012:key/abc", Condition: condition } } },
        },
      },
    });
    const rules = (condition: Record<string, Record<string, unknown>>) => kmsPolicyFindings(tagging(condition)).map((finding) => finding.rule);
    expect(rules({ StringLike: { "aws:RequestTag/vibtra:org": "o1" } })).toEqual(["kms-tag-resource"]);
    expect(rules({ StringEquals: { "aws:RequestTag/vibtra:org": "*" } })).toEqual(["kms-tag-resource"]);
    expect(rules({ StringEquals: { "aws:RequestTag/vibtra:org": ["o1", "o*"] } })).toEqual(["kms-tag-resource"]);
    expect(rules({ StringEquals: { "aws:RequestTag/vibtra:org": [] } })).toEqual(["kms-tag-resource"]);
    expect(rules({ StringEquals: { "aws:RequestTag/vibtra:org": "o1" } })).toEqual([]);
  });

  it("S7: new kms.Key() synthesises clean, because the default key policy grants kms:* to the account root, while a key policy statement for any other principal is still checked", async () => {
    const dir = await outdir();
    const keyOnly = fixtureStack(dir, (stack) => new kms.Key(stack, "Key"));
    expect((await findingsOf(keyOnly, dir)).filter((finding) => finding.includes(" kms-"))).toEqual([]);
    const findings = kmsPolicyFindings({
      Resources: {
        Key: {
          Type: "AWS::KMS::Key",
          Properties: {
            KeyPolicy: {
              Statement: [
                { Effect: "Allow", Principal: { AWS: { "Fn::Join": ["", ["arn:", { Ref: "AWS::Partition" }, ":iam::", { Ref: "AWS::AccountId" }, ":root"]] } }, Action: "kms:*", Resource: "*" },
                { Effect: "Allow", Principal: { AWS: "arn:aws:iam::123456789012:role/app" }, Action: "kms:*", Resource: "*" },
              ],
            },
          },
        },
      },
    });
    expect(findings.map((finding) => `${finding.logicalId} ${finding.rule}`)).toEqual(["Key kms-wildcard-resource", "Key kms-tag-resource"]);
  });
});
