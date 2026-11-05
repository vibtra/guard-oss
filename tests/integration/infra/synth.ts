import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { fileURLToPath } from "node:url";

export const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));
export const infraDir = join(repoRoot, "infra");

export interface CfnResource {
  readonly Type: string;
  readonly Properties?: Record<string, unknown>;
  readonly DeletionPolicy?: string;
  readonly UpdateReplacePolicy?: string;
}

export interface CfnOutput {
  readonly Value: unknown;
  readonly Description?: string;
}

export interface CfnTemplate {
  readonly Resources: Record<string, CfnResource>;
  readonly Outputs: Record<string, CfnOutput>;
}

export interface AppRun {
  readonly status: number | null;
  readonly stderr: string;
  readonly stacks: Readonly<Record<string, { readonly environment: string; readonly template: CfnTemplate }>>;
}

export interface Synthesized {
  readonly registry: CfnTemplate;
  readonly ecr: CfnTemplate;
  readonly edge: CfnTemplate | undefined;
  readonly environments: Readonly<Record<string, string>>;
}

interface CdkJson {
  readonly app: string;
  readonly context?: Record<string, unknown>;
}

interface AssemblyManifest {
  readonly artifacts?: Record<
    string,
    { readonly type: string; readonly environment?: string; readonly properties?: { readonly templateFile?: string } }
  >;
}

const childEnv = (extra: Record<string, string>): NodeJS.ProcessEnv => {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (key.startsWith("CDK_") || key.startsWith("AWS_") || key === "NODE_OPTIONS" || key === "NODE_V8_COVERAGE") continue;
    env[key] = value;
  }
  env["PATH"] = [join(infraDir, "node_modules", ".bin"), process.env["PATH"] ?? ""].join(delimiter);
  return { ...env, ...extra };
};

const runApp = async (context: Record<string, string>, env: Record<string, string>): Promise<AppRun> => {
  const cdkJson = JSON.parse(await readFile(join(infraDir, "cdk.json"), "utf8")) as CdkJson;
  const outdir = await mkdtemp(join(tmpdir(), "vibtra-infra-synth-"));
  try {
    const { status, stderr } = await new Promise<{ status: number | null; stderr: string }>((resolve, reject) => {
      const child = spawn(cdkJson.app, {
        cwd: infraDir,
        shell: true,
        stdio: ["ignore", "ignore", "pipe"],
        env: childEnv({
          ...env,
          CDK_OUTDIR: outdir,
          CDK_CONTEXT_JSON: JSON.stringify({ ...cdkJson.context, ...context }),
        }),
      });
      let text = "";
      child.stderr.setEncoding("utf8");
      child.stderr.on("data", (chunk: string) => {
        text += chunk;
      });
      child.once("error", reject);
      child.once("close", (code) => resolve({ status: code, stderr: text }));
    });
    if (status !== 0) return { status, stderr, stacks: {} };
    const manifest = JSON.parse(await readFile(join(outdir, "manifest.json"), "utf8")) as AssemblyManifest;
    const stacks: Record<string, { environment: string; template: CfnTemplate }> = {};
    for (const [id, artifact] of Object.entries(manifest.artifacts ?? {})) {
      const file = artifact.properties?.templateFile;
      if (artifact.type !== "aws:cloudformation:stack" || file === undefined) continue;
      const template = JSON.parse(await readFile(join(outdir, file), "utf8")) as Partial<CfnTemplate>;
      stacks[id] = {
        environment: artifact.environment ?? "",
        template: { Resources: template.Resources ?? {}, Outputs: template.Outputs ?? {} },
      };
    }
    return { status, stderr, stacks };
  } finally {
    await rm(outdir, { recursive: true, force: true });
  }
};

const runs = new Map<string, Promise<AppRun>>();

export const runCdkApp = (context: Record<string, string> = {}, env: Record<string, string> = {}): Promise<AppRun> => {
  const key = JSON.stringify([context, env]);
  const known = runs.get(key);
  if (known !== undefined) return known;
  const started = runApp(context, env);
  runs.set(key, started);
  return started;
};

export const synth = async (context: Record<string, string> = {}, env: Record<string, string> = {}): Promise<Synthesized> => {
  const run = await runCdkApp(context, env);
  const registry = run.stacks["VibtraRegistry"];
  const ecr = run.stacks["VibtraRegistryEcr"];
  if (run.status !== 0 || registry === undefined || ecr === undefined) {
    throw new Error(`the CDK app did not synthesise (exit ${String(run.status)}):\n${run.stderr}`);
  }
  return {
    registry: registry.template,
    ecr: ecr.template,
    edge: run.stacks["VibtraRegistryEdgeCertificate"]?.template,
    environments: Object.fromEntries(Object.entries(run.stacks).map(([id, stack]) => [id, stack.environment])),
  };
};

export const refusal = async (context: Record<string, string>, env: Record<string, string> = {}): Promise<string> => {
  const run = await runCdkApp(context, env);
  if (run.status === 0) throw new Error(`the CDK app synthesised a context it must refuse: ${JSON.stringify(context)}`);
  return run.stderr;
};

export const resources = (template: CfnTemplate, type: string): Array<[string, CfnResource]> =>
  Object.entries(template.Resources).filter(([, resource]) => resource.Type === type);

export const propertiesOf = (resource: CfnResource | undefined): Record<string, unknown> => resource?.Properties ?? {};

export const only = (template: CfnTemplate, type: string): [string, CfnResource] => {
  const found = resources(template, type);
  const first = found[0];
  if (found.length !== 1 || first === undefined) throw new Error(`expected exactly one ${type}, found ${found.length}`);
  return first;
};

export interface Container {
  readonly Name: string;
  readonly Image?: unknown;
  readonly Command?: string[];
  readonly EntryPoint?: string[];
  readonly Environment?: Array<{ readonly Name: string; readonly Value: unknown }>;
  readonly Secrets?: Array<{ readonly Name: string; readonly ValueFrom: unknown }>;
  readonly HealthCheck?: { readonly Command: string[] };
}

export const taskDefinitions = (template: CfnTemplate): Array<Record<string, unknown>> =>
  resources(template, "AWS::ECS::TaskDefinition").map(([, resource]) => propertiesOf(resource));

export const containers = (template: CfnTemplate): Container[] =>
  taskDefinitions(template).flatMap((task) => (task["ContainerDefinitions"] as Container[] | undefined) ?? []);

export const container = (template: CfnTemplate, name: string): Container => {
  const found = containers(template).find((c) => c.Name === name);
  if (found === undefined) throw new Error(`no container named ${name} in the template`);
  return found;
};

export const envOf = (c: Container): Record<string, unknown> =>
  Object.fromEntries((c.Environment ?? []).map((entry) => [entry.Name, entry.Value]));

export const secretNamesOf = (c: Container): string[] => (c.Secrets ?? []).map((secret) => secret.Name);

export const entryScriptOf = (c: Container): string => c.EntryPoint?.[2] ?? "";

export interface Behaviour {
  readonly PathPattern?: string;
  readonly FunctionAssociations?: Array<{ readonly EventType: string; readonly FunctionARN: unknown }>;
  readonly TargetOriginId: string;
  readonly AllowedMethods?: string[];
  readonly Compress?: boolean;
  readonly CachePolicyId?: string;
  readonly OriginRequestPolicyId?: string;
  readonly ViewerProtocolPolicy: string;
}

export interface Distribution {
  readonly Aliases?: string[];
  readonly Enabled: boolean;
  readonly HttpVersion?: string;
  readonly IPV6Enabled?: boolean;
  readonly PriceClass?: string;
  readonly ViewerCertificate?: {
    readonly AcmCertificateArn?: unknown;
    readonly MinimumProtocolVersion?: string;
    readonly SslSupportMethod?: string;
  };
  readonly DefaultCacheBehavior: Behaviour;
  readonly CacheBehaviors?: Behaviour[];
  readonly CustomErrorResponses?: Array<{
    readonly ErrorCode: number;
    readonly ErrorCachingMinTTL?: number;
    readonly ResponsePagePath?: string;
    readonly ResponseCode?: number;
  }>;
  readonly Origins: Array<{
    readonly Id: string;
    readonly DomainName: unknown;
    readonly CustomOriginConfig?: {
      readonly OriginProtocolPolicy: string;
      readonly OriginSSLProtocols?: string[];
      readonly OriginReadTimeout?: number;
      readonly OriginKeepaliveTimeout?: number;
    };
  }>;
}

export const distributionOf = (template: CfnTemplate): Distribution =>
  propertiesOf(only(template, "AWS::CloudFront::Distribution")[1])["DistributionConfig"] as Distribution;

export const guardDockerfile = async (): Promise<{ entrypoint: string[]; cmd: string[]; text: string }> => {
  const text = await readFile(join(repoRoot, "apps", "registry", "Dockerfile"), "utf8");
  const execForm = (directive: string): string[] => {
    const line = text.split("\n").find((l) => l.startsWith(`${directive} [`));
    if (line === undefined) throw new Error(`apps/registry/Dockerfile has no exec-form ${directive}`);
    return JSON.parse(line.slice(directive.length + 1)) as string[];
  };
  return { entrypoint: execForm("ENTRYPOINT"), cmd: execForm("CMD"), text };
};
