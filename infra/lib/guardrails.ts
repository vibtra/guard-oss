import { readFileSync } from "node:fs";
import { Validations, type App, type IPolicyValidationContext, type IPolicyValidationPlugin, type PolicyValidationPluginReport, type PolicyViolation } from "aws-cdk-lib";
import cdkNag from "cdk-nag";
import type { IConstruct } from "constructs";

const { AwsSolutionsChecks } = cdkNag;

export interface NagSuppression {
  readonly path: string;
  readonly id: string;
  readonly reason: string;
}

const SUPPRESSIONS_FILE = new URL("../nag-suppressions.json", import.meta.url);

const MIN_REASON_LENGTH = 20;

export const readNagSuppressions = (file: URL = SUPPRESSIONS_FILE): NagSuppression[] => {
  const parsed = JSON.parse(readFileSync(file, "utf8")) as { suppressions?: NagSuppression[] };
  const rows = parsed.suppressions ?? [];
  for (const row of rows) {
    if (typeof row.reason !== "string" || row.reason.trim().length < MIN_REASON_LENGTH) {
      throw new Error(
        `infra/nag-suppressions.json: the ${row.id} suppression on ${row.path} has no reason. ` +
          `Write why the finding is safe (at least ${MIN_REASON_LENGTH} characters), or fix the construct instead.`,
      );
    }
  }
  return rows;
};

type Statement = {
  readonly Effect?: string;
  readonly Action?: unknown;
  readonly NotAction?: unknown;
  readonly Resource?: unknown;
  readonly Principal?: unknown;
  readonly Condition?: Record<string, Record<string, unknown> | undefined>;
};

export interface KmsTemplate {
  readonly Resources?: Record<string, { readonly Type?: string; readonly Properties?: Record<string, unknown> }>;
}

export interface KmsPolicyFinding {
  readonly rule: "kms-wildcard-resource" | "kms-tag-resource";
  readonly logicalId: string;
  readonly problem: string;
}

const listOf = (value: unknown): unknown[] => (value === undefined ? [] : Array.isArray(value) ? value : [value]);

const renderSub = (sub: unknown): string | undefined => {
  const [template, variables] = Array.isArray(sub) ? sub : [sub, {}];
  if (typeof template !== "string") return undefined;
  const values = (variables ?? {}) as Record<string, unknown>;
  return template.replaceAll(/\$\{(!?)([^}]*)\}/g, (_, literal: string, name: string) =>
    literal === "!" ? `\${${name}}` : name in values ? textOf(values[name]) : "${token}",
  );
};

const textOf = (value: unknown): string => {
  if (typeof value === "string") return value;
  const join = (value as { "Fn::Join"?: unknown } | undefined)?.["Fn::Join"];
  if (Array.isArray(join) && typeof join[0] === "string") return listOf(join[1]).map(textOf).join(join[0]);
  const sub = (value as { "Fn::Sub"?: unknown } | undefined)?.["Fn::Sub"];
  if (sub !== undefined) return renderSub(sub) ?? "${token}";
  return "${token}";
};

const isAccountRoot = (principal: unknown): boolean => {
  const aws = listOf((principal as { AWS?: unknown } | undefined)?.AWS);
  return aws.length > 0 && aws.every((entry) => /^\d{12}$/.test(textOf(entry)) || textOf(entry).endsWith(":root"));
};

const statementsOf = (properties: Record<string, unknown>): Statement[] => {
  const keyPolicy = listOf((properties["KeyPolicy"] as { Statement?: unknown } | undefined)?.Statement) as Statement[];
  const documents: unknown[] = [properties["PolicyDocument"]];
  for (const policy of listOf(properties["Policies"])) documents.push((policy as { PolicyDocument?: unknown }).PolicyDocument);
  return [
    ...documents.flatMap((document) => listOf((document as { Statement?: unknown } | undefined)?.Statement) as Statement[]),
    ...keyPolicy.filter((statement) => !isAccountRoot(statement.Principal)),
  ];
};

const isFixedValue = (value: unknown): boolean =>
  listOf(value).length > 0 && listOf(value).every((entry) => typeof entry === "string" && entry !== "" && !/[*?]/.test(entry));

const PINNING_OPERATORS = ["StringEquals", "ForAnyValue:StringEquals"];

const pins = (statement: Statement, operators: readonly string[], matches: (key: string) => boolean): boolean =>
  operators.some((operator) => Object.entries(statement.Condition?.[operator] ?? {}).some(([key, value]) => matches(key.toLowerCase()) && isFixedValue(value)));

const pinsKeyType = (statement: Statement): boolean =>
  pins(statement, PINNING_OPERATORS, (key) => key === "kms:keyspec") && pins(statement, PINNING_OPERATORS, (key) => key === "kms:keyusage");

const pinsRequestTag = (statement: Statement): boolean => pins(statement, ["StringEquals"], (key) => key.startsWith("aws:requesttag/"));

const grants = (action: string, wanted: string): boolean => {
  const pattern = action.toLowerCase().replaceAll(/[.+^${}()|[\]\\]/g, "\\$&").replaceAll("*", ".*").replaceAll("?", ".");
  return new RegExp(`^${pattern}$`).test(wanted.toLowerCase());
};

const isWildcardResource = (resource: unknown): boolean => {
  const text = textOf(resource);
  return text === "*" || /(?:^|[:/])(?:key|alias)\/\*$/.test(text) || /^arn:[^:]*:kms:[^:]*:[^:]*:\*$/.test(text);
};

const grantedActions = (statement: Statement): string[] => {
  const actions = listOf(statement.Action).filter((action): action is string => typeof action === "string");
  if (statement.NotAction === undefined) return actions;
  const excluded = listOf(statement.NotAction).filter((action): action is string => typeof action === "string");
  return excluded.some((action) => grants(action, "kms:*")) ? actions : [...actions, "kms:* (through NotAction)"];
};

const grantsKms = (action: string, wanted: string): boolean => (action === "kms:* (through NotAction)" ? true : grants(action, wanted));

export const kmsPolicyFindings = (template: KmsTemplate): KmsPolicyFinding[] => {
  const findings: KmsPolicyFinding[] = [];
  for (const [logicalId, resource] of Object.entries(template.Resources ?? {})) {
    for (const statement of statementsOf(resource.Properties ?? {})) {
      if (statement.Effect !== "Allow") continue;
      const actions = grantedActions(statement);
      const kmsActions = actions.filter((action) => action === "*" || action.toLowerCase().startsWith("kms:"));
      const wildcards = listOf(statement.Resource).filter(isWildcardResource).map(textOf);
      if (kmsActions.length > 0 && wildcards.length > 0 && !pinsKeyType(statement)) {
        findings.push({
          rule: "kms-wildcard-resource",
          logicalId,
          problem:
            `allows ${kmsActions.join(", ")} on ${wildcards.map((text) => JSON.stringify(text)).join(", ")} without StringEquals conditions that pin kms:KeySpec and kms:KeyUsage to fixed values. ` +
            "Scope the statement to the key ARNs it needs, or add both conditions (StringEquals, no wildcard) so it reaches only the key type the registry uses.",
        });
      }
      if (actions.some((action) => grantsKms(action, "kms:TagResource")) && !pinsRequestTag(statement)) {
        findings.push({
          rule: "kms-tag-resource",
          logicalId,
          problem:
            "allows kms:TagResource without a StringEquals aws:RequestTag/<key> condition on a fixed value, so the role can tag, and so claim, keys it did not create. " +
            "Add a StringEquals aws:RequestTag/<key> condition that pins the tag the registry sets, with no wildcard in the value.",
        });
      }
    }
  }
  return findings;
};

class KmsPolicyChecks implements IPolicyValidationPlugin {
  public readonly name = "VibtraKmsPolicy";

  public readonly ruleIds = ["kms-wildcard-resource", "kms-tag-resource"];

  public validate(context: IPolicyValidationContext): PolicyValidationPluginReport {
    const violations = new Map<string, PolicyViolation>();
    for (const stack of context.stackTemplates) {
      const template = JSON.parse(readFileSync(stack.templatePath, "utf8")) as KmsTemplate;
      for (const finding of kmsPolicyFindings(template)) {
        const violation = violations.get(finding.rule) ?? { ruleName: finding.rule, description: finding.problem, severity: "error", violatingResources: [] };
        violations.set(finding.rule, {
          ...violation,
          violatingResources: [...violation.violatingResources, { resourceLogicalId: finding.logicalId, templatePath: stack.templatePath, locations: ["Properties"] }],
        });
      }
    }
    return { success: violations.size === 0, violations: [...violations.values()] };
  }
}

export const applyNagChecks = (app: App, suppressions: readonly NagSuppression[] = readNagSuppressions()): void => {
  Validations.of(app).addPlugins(new AwsSolutionsChecks(app, { verbose: true }), new KmsPolicyChecks());
  const nodes = new Map<string, IConstruct>(app.node.findAll().map((node) => [node.node.path, node]));
  for (const row of suppressions) {
    nodes.get(row.path)?.node.addMetadata(Validations.ACKNOWLEDGED_RULES_METADATA_KEY, { [row.id]: row.reason });
  }
};
