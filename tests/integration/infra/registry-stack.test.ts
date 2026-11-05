import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  container,
  containers,
  entryScriptOf,
  envOf,
  guardDockerfile,
  only,
  propertiesOf,
  repoRoot,
  resources,
  secretNamesOf,
  synth,
  taskDefinitions,
  type CfnTemplate,
} from "./synth.js";

const GOOGLE_SECRET_ARN = "arn:aws:secretsmanager:ap-southeast-2:123456789012:secret:google-abc123";
const PREVIOUS_VAULT_KEY_ARN = "arn:aws:secretsmanager:ap-southeast-2:123456789012:secret:vault-old-abc123";
const CREDENTIALS = ["REGISTRY_SESSION_SECRET", "VIBTRA_VAULT_KEY", "DB_PASSWORD", "REGISTRY_OIDC_CLIENT_SECRET"];

const allSecretNames = (template: CfnTemplate): string[] => [...new Set(containers(template).flatMap(secretNamesOf))].sort();

describe("VibtraRegistry synthesises from the real app", () => {
  it("produces a full template", async () => {
    const { registry } = await synth();
    expect(Object.keys(registry.Resources).length).toBeGreaterThan(20);
  });

  it("runs Postgres Multi-AZ, encrypted, private, backed up, deletion-protected and retained", async () => {
    const { registry } = await synth();
    const [, database] = only(registry, "AWS::RDS::DBInstance");
    expect(propertiesOf(database)).toMatchObject({
      Engine: "postgres",
      MultiAZ: true,
      StorageEncrypted: true,
      PubliclyAccessible: false,
      BackupRetentionPeriod: 7,
      DeletionProtection: true,
    });
    expect(database.DeletionPolicy).toBe("Retain");
  });

  it("terminates TLS on the load balancer and has no :80 listener", async () => {
    const { registry } = await synth();
    const listeners = resources(registry, "AWS::ElasticLoadBalancingV2::Listener");
    expect(listeners).toHaveLength(1);
    expect(propertiesOf(listeners[0]?.[1])).toMatchObject({ Protocol: "HTTPS", Port: 443 });
    expect(JSON.stringify(listeners)).not.toContain('"Port":80');
  });

  it("health-checks Better Auth's own endpoint and expects 200", async () => {
    const { registry } = await synth();
    expect(propertiesOf(only(registry, "AWS::ElasticLoadBalancingV2::TargetGroup")[1])).toMatchObject({
      HealthCheckPath: "/api/auth/ok",
      Matcher: { HttpCode: "200" },
    });
  });

  it("keeps the tasks off public IPs", async () => {
    const { registry } = await synth();
    expect(propertiesOf(only(registry, "AWS::ECS::Service")[1])).toMatchObject({
      NetworkConfiguration: { AwsvpcConfiguration: { AssignPublicIp: "DISABLED" } },
    });
  });

  it("injects every credential as an ECS secret and none as a plain environment variable", async () => {
    const { registry } = await synth({ googleClientSecretArn: GOOGLE_SECRET_ARN });
    for (const c of containers(registry)) {
      for (const name of CREDENTIALS) expect(Object.keys(envOf(c)), `${c.Name} ${name}`).not.toContain(name);
    }
    expect(allSecretNames(registry)).toEqual(expect.arrayContaining([...CREDENTIALS, "DB_USER"]));
  });

  it("injects exactly the secrets each task needs, and REGISTRY_ISSUER_KEY nowhere", async () => {
    const { registry } = await synth({ googleClientSecretArn: GOOGLE_SECRET_ARN });
    expect(taskDefinitions(registry)).toHaveLength(2);
    expect(containers(registry).map((c) => c.Name).sort()).toEqual(["registry", "reseal"]);
    for (const c of containers(registry)) {
      expect(secretNamesOf(c).sort(), c.Name).toEqual([
        "DB_PASSWORD",
        "DB_USER",
        "REGISTRY_GATE_SIGNING_SECRET",
        "REGISTRY_OIDC_CLIENT_SECRET",
        "REGISTRY_SESSION_SECRET",
        "VIBTRA_VAULT_KEY",
      ]);
      expect(Object.keys(envOf(c)), c.Name).not.toContain("REGISTRY_ISSUER_KEY");
    }
    expect(JSON.stringify(registry)).not.toContain("REGISTRY_ISSUER_KEY");
  });

  it("declares two Secrets Manager entries whose descriptions each name one job", async () => {
    const { registry } = await synth();
    const descriptions = resources(registry, "AWS::SecretsManager::Secret").map(([, r]) =>
      JSON.stringify(propertiesOf(r)["Description"] ?? ""),
    );
    const session = descriptions.find((d) => d.includes("REGISTRY_SESSION_SECRET") || d.includes("Better Auth `secret`"));
    const gate = descriptions.find((d) => d.includes("REGISTRY_GATE_SIGNING_SECRET"));
    expect(session, "no session-secret description").toBeDefined();
    expect(gate, "no gate-signing-secret description").toBeDefined();
    expect(session).not.toBe(gate);
    expect(session).toContain("CONSOLE SESSIONS ONLY");
    expect(session).toContain("signs everyone out");
    expect(session).toMatch(/does NOT touch the tool-gate signing key/);
    expect(gate).toContain("jwks");
    expect(gate).toContain("rotate-issuer-key");
    expect(gate).toContain("does NOT sign anyone out of the console");
    expect(session).toContain("docs/deploy-registry-aws.md §1.5");
    expect(gate).toContain("docs/deploy-registry-aws.md §1.5");
  });

  it("publishes both secret ARNs and the vault key ARN as outputs, and no secret value", async () => {
    const { registry } = await synth();
    expect(Object.keys(registry.Outputs)).toEqual(
      expect.arrayContaining(["SessionSecretArn", "GateSigningSecretArn", "VaultKeySecretArn"]),
    );
    expect(registry.Outputs["SessionSecretArn"]?.Description).toContain("Console sessions only");
    expect(registry.Outputs["GateSigningSecretArn"]?.Description).toContain("BACK THIS UP");
    expect(JSON.stringify(registry.Outputs)).not.toMatch(/SecretString/);
  });

  it("never renders a secret value into the template", async () => {
    const { registry } = await synth();
    expect(JSON.stringify(registry)).not.toMatch(/"SecretString"\s*:\s*"[A-Za-z0-9+/]{20,}"/);
  });

  it("generates a retained hex-64 vault key", async () => {
    const { registry } = await synth();
    const vaultKeys = resources(registry, "AWS::SecretsManager::Secret").filter(([, r]) => {
      const generate = propertiesOf(r)["GenerateSecretString"] as Record<string, unknown> | undefined;
      return (
        generate?.["PasswordLength"] === 64 &&
        generate["ExcludeUppercase"] === true &&
        generate["ExcludePunctuation"] === true &&
        generate["ExcludeCharacters"] === "ghijklmnopqrstuvwxyz"
      );
    });
    expect(vaultKeys).toHaveLength(1);
    expect(vaultKeys[0]?.[1].DeletionPolicy).toBe("Retain");
  });

  it("writes every security-group rule description in the alphabet EC2 accepts", async () => {
    const accepted = /^[a-zA-Z0-9. _\-:/()#,@[\]+=&;{}!$*]{0,255}$/;
    const { registry, ecr } = await synth();
    const descriptions: string[] = [];
    for (const template of [registry, ecr]) {
      for (const [, group] of resources(template, "AWS::EC2::SecurityGroup")) {
        const p = propertiesOf(group);
        for (const rule of [
          ...((p["SecurityGroupIngress"] as Array<{ Description?: string }> | undefined) ?? []),
          ...((p["SecurityGroupEgress"] as Array<{ Description?: string }> | undefined) ?? []),
        ]) {
          if (rule.Description !== undefined) descriptions.push(rule.Description);
        }
      }
      for (const type of ["AWS::EC2::SecurityGroupIngress", "AWS::EC2::SecurityGroupEgress"]) {
        for (const [, rule] of resources(template, type)) {
          const description = propertiesOf(rule)["Description"];
          if (typeof description === "string") descriptions.push(description);
        }
      }
    }
    expect(descriptions.length).toBeGreaterThan(0);
    for (const description of descriptions) expect(description, description).toMatch(accepted);
  });

  it("makes the registry and reseal tasks speak TLS to RDS with verify-full and Amazon's CA", async () => {
    const { registry } = await synth();
    for (const name of ["registry", "reseal"]) {
      const c = container(registry, name);
      const entry = entryScriptOf(c);
      expect(entry, name).toContain("?sslmode=verify-full&sslrootcert=/tmp/rds-ca.pem");
      expect(entry, name).toContain(`printf '%s\\n' "$RDS_CA_BUNDLE" > /tmp/rds-ca.pem`);
      expect(entry.indexOf("$RDS_CA_BUNDLE")).toBeLessThan(entry.indexOf("export DATABASE_URL"));
      expect(entry.indexOf("export DATABASE_URL")).toBeLessThan(entry.indexOf('exec guard-entrypoint "$0"'));
      expect(String(envOf(c)["RDS_CA_BUNDLE"]), name).toContain("-----BEGIN CERTIFICATE-----");
    }
  });

  it("lets the database password generator use URL-unreserved punctuation and excludes DSN-breaking characters", async () => {
    const { registry } = await synth();
    const generators = resources(registry, "AWS::SecretsManager::Secret")
      .map(([, r]) => propertiesOf(r)["GenerateSecretString"] as Record<string, unknown> | undefined)
      .filter((g) => String(g?.["SecretStringTemplate"] ?? "").includes('"username":"vibtra"'));
    expect(generators).toHaveLength(1);
    const generator = generators[0] ?? {};
    expect(generator["ExcludePunctuation"]).toBeUndefined();
    const excluded = String(generator["ExcludeCharacters"]);
    for (const c of ["@", "/", ":", "?", "#", "%", "&", "=", "+", " ", '"', "'"]) expect(excluded, `excludes ${c}`).toContain(c);
    for (const c of ["-", "_", "."]) expect(excluded, `keeps ${c}`).not.toContain(c);
    expect(Number(generator["PasswordLength"] ?? 32)).toBeGreaterThanOrEqual(30);
  });

  it("tells the container it is hosted, in production, at the base URL derived from -c domainName", async () => {
    const { registry } = await synth({ domainName: "registry.example.test", contactEmail: "ops@example.test" });
    expect(envOf(container(registry, "registry"))).toMatchObject({
      REGISTRY_MODE: "hosted",
      NODE_ENV: "production",
      REGISTRY_BASE_URL: "https://registry.example.test",
    });
  });

  it("closes sign-ups to an allowlist, derives the operator from the domain and publishes one contact address", async () => {
    const shipped = envOf(container((await synth()).registry, "registry"));
    expect(shipped["REGISTRY_REGISTRATION"]).toBe("allowlist");
    expect(shipped["REGISTRY_OPERATOR_DOMAIN"]).toBe("vibtra.app");
    expect(String(shipped["REGISTRY_CONTACT_EMAIL"])).toMatch(/^[^@\s]+@vibtra\.app$/);
    const moved = envOf(
      container((await synth({ domainName: "registry.example.test", contactEmail: "ops@example.test" })).registry, "registry"),
    );
    expect(moved["REGISTRY_REGISTRATION"]).toBe("allowlist");
    expect(moved["REGISTRY_OPERATOR_DOMAIN"]).toBe("registry.example.test");
    expect(moved["REGISTRY_CONTACT_EMAIL"]).toBe("ops@example.test");
  });

  it("composes DATABASE_URL inside the container, not in the template", async () => {
    const { registry } = await synth();
    for (const name of ["registry", "reseal"]) expect(entryScriptOf(container(registry, name)), name).toContain("export DATABASE_URL=");
    expect(JSON.stringify(registry)).not.toMatch(/"Name":"DATABASE_URL"/);
  });

  it("supplies a command wherever it overrides the entry point, and runs the image's own CMD and ENTRYPOINT", async () => {
    const { registry } = await synth();
    const all = containers(registry);
    expect(all.length).toBeGreaterThan(1);
    for (const c of all) {
      if (c.EntryPoint !== undefined) expect(c.Command, `${c.Name} overrides EntryPoint but supplies no Command`).toBeDefined();
    }
    const image = await guardDockerfile();
    const service = container(registry, "registry");
    const reseal = container(registry, "reseal");
    expect(service.Command).toEqual(image.cmd);
    expect(reseal.Command).toEqual([...image.cmd, "reseal"]);
    for (const c of [service, reseal]) {
      expect(entryScriptOf(c)).toMatch(new RegExp(`exec ${image.entrypoint[0] ?? "<none>"} "\\$0" "\\$@"$`));
      expect(c.Command?.join(" ")).not.toContain("pnpm");
    }
  });

  it("ships one task by default with no scaling policy", async () => {
    const { registry } = await synth();
    expect(propertiesOf(only(registry, "AWS::ApplicationAutoScaling::ScalableTarget")[1])).toMatchObject({
      MinCapacity: 1,
      MaxCapacity: 1,
    });
    expect(resources(registry, "AWS::ApplicationAutoScaling::ScalingPolicy")).toHaveLength(0);
  });

  it("autoscales on CPU above the desired count when -c maxCapacity raises the ceiling", async () => {
    const { registry } = await synth({ maxCapacity: "6" });
    expect(propertiesOf(only(registry, "AWS::ApplicationAutoScaling::ScalableTarget")[1])).toMatchObject({
      MinCapacity: 1,
      MaxCapacity: 6,
    });
    expect(propertiesOf(only(registry, "AWS::ApplicationAutoScaling::ScalingPolicy")[1])).toMatchObject({
      TargetTrackingScalingPolicyConfiguration: { TargetValue: 60 },
    });
  });

  it("carries the previous vault key only when a rotation names it", async () => {
    expect(allSecretNames((await synth()).registry)).not.toContain("VIBTRA_VAULT_KEY_PREVIOUS");
    const rotating = await synth({ vaultKeyPreviousSecretArn: PREVIOUS_VAULT_KEY_ARN });
    for (const name of ["registry", "reseal"]) {
      expect(secretNamesOf(container(rotating.registry, name)), name).toContain("VIBTRA_VAULT_KEY_PREVIOUS");
    }
  });

  it("publishes the network the reseal task must run in", async () => {
    const { registry } = await synth();
    expect(Object.keys(registry.Outputs)).toEqual(expect.arrayContaining(["ResealSecurityGroupId", "ResealSubnetIds"]));
  });

  it("gives the reseal command its own task definition that no service runs", async () => {
    const { registry } = await synth();
    const resealTasks = resources(registry, "AWS::ECS::TaskDefinition").filter(([, task]) =>
      ((propertiesOf(task)["ContainerDefinitions"] as Array<{ Name: string }> | undefined) ?? []).some((c) => c.Name === "reseal"),
    );
    expect(resealTasks).toHaveLength(1);
    const [resealId] = resealTasks[0] ?? [];
    const [, service] = only(registry, "AWS::ECS::Service");
    expect(JSON.stringify(propertiesOf(service)["TaskDefinition"])).not.toContain(resealId ?? "<none>");
  });

  it("retains the registry's log group with the retention from the context", async () => {
    const cases: Array<[Record<string, string>, number]> = [
      [{}, 90],
      [{ logRetentionDays: "30" }, 30],
    ];
    for (const [context, days] of cases) {
      const retained = resources((await synth(context)).registry, "AWS::Logs::LogGroup").filter(
        ([, group]) => group.DeletionPolicy === "Retain",
      );
      expect(retained.map(([id]) => id)).toEqual([expect.stringMatching(/^RegistryLogs/)]);
      expect(propertiesOf(retained[0]?.[1])["RetentionInDays"]).toBe(days);
    }
  });

  it("writes Route 53 records only with a zone, and aliases the apex and www, both families, to the distribution", async () => {
    expect(resources((await synth()).registry, "AWS::Route53::RecordSet")).toHaveLength(0);
    const { registry } = await synth({ hostedZoneId: "Z0123456789ABCDEFGHIJ", hostedZoneName: "vibtra.app" });
    const records = resources(registry, "AWS::Route53::RecordSet").map(([, r]) => propertiesOf(r));
    expect(records.map((r) => `${String(r["Name"])} ${String(r["Type"])}`).sort()).toEqual([
      "vibtra.app. A",
      "vibtra.app. AAAA",
      "www.vibtra.app. A",
      "www.vibtra.app. AAAA",
    ]);
    const [distributionId] = only(registry, "AWS::CloudFront::Distribution");
    for (const record of records) {
      const target = record["AliasTarget"] as { DNSName: unknown };
      expect(JSON.stringify(target.DNSName)).toContain(distributionId);
      expect(JSON.stringify(target.DNSName)).toContain("DomainName");
      expect(JSON.stringify(target)).not.toMatch(/LoadBalancer|ServiceLB/);
    }
  });

  it("puts the database in isolated subnets: three tiers in two zones and one NAT gateway", async () => {
    const { registry } = await synth();
    expect(resources(registry, "AWS::EC2::Subnet")).toHaveLength(6);
    expect(resources(registry, "AWS::EC2::NatGateway")).toHaveLength(1);
  });

  it("leaves through one retained Elastic IP and publishes it for customers to allowlist", async () => {
    const { registry } = await synth();
    expect(resources(registry, "AWS::EC2::NatGateway")).toHaveLength(1);
    const [eipId, eip] = only(registry, "AWS::EC2::EIP");
    expect(eip.DeletionPolicy).toBe("Retain");
    const [, nat] = only(registry, "AWS::EC2::NatGateway");
    expect(JSON.stringify(propertiesOf(nat)["AllocationId"])).toContain(eipId);
    const output = registry.Outputs["ManagedConnectionEgressIp"];
    expect(output, "the egress address is not published").toBeDefined();
    expect(JSON.stringify(output?.Value)).toContain(eipId);
    expect(JSON.stringify(output?.Value)).toContain("PublicIp");
    expect(JSON.stringify(output)).not.toMatch(/SecretString|secret-id|password/i);
  });
});

describe("VibtraRegistryEcr", () => {
  it("keeps images when the stack goes away, scans on push and refuses tag overwrites", async () => {
    const { ecr } = await synth();
    const [, repository] = only(ecr, "AWS::ECR::Repository");
    expect(propertiesOf(repository)).toMatchObject({
      ImageScanningConfiguration: { ScanOnPush: true },
      ImageTagMutability: "IMMUTABLE",
    });
    expect(repository.DeletionPolicy).toBe("Retain");
  });
});

describe("the task definitions match the Guard server image", () => {
  it("injects all three server secrets as secrets, the condition under which the image entrypoint writes nothing", async () => {
    const script = await readFile(join(repoRoot, "apps", "registry", "docker-entrypoint.sh"), "utf8");
    expect(script).toContain(
      'if [ -n "${REGISTRY_SESSION_SECRET:-}" ] && [ -n "${REGISTRY_GATE_SIGNING_SECRET:-}" ] && [ -n "${VIBTRA_VAULT_KEY:-}" ]; then',
    );
    const { registry } = await synth();
    for (const name of ["registry", "reseal"]) {
      const c = container(registry, name);
      for (const secret of ["REGISTRY_SESSION_SECRET", "REGISTRY_GATE_SIGNING_SECRET", "VIBTRA_VAULT_KEY"]) {
        expect(secretNamesOf(c), `${name} ${secret}`).toContain(secret);
        expect(Object.keys(envOf(c)), `${name} ${secret} must not be plain env`).not.toContain(secret);
      }
    }
  });

  it("tells both tasks they are hosted, in production, at https://vibtra.app, signing in with Google", async () => {
    const { registry } = await synth();
    for (const name of ["registry", "reseal"]) {
      expect(envOf(container(registry, name)), name).toMatchObject({
        REGISTRY_MODE: "hosted",
        REGISTRY_BASE_URL: "https://vibtra.app",
        REGISTRY_OIDC_PROVIDER: "google",
        NODE_ENV: "production",
      });
    }
    expect(registry.Outputs["GoogleRedirectUri"]?.Value).toBe("https://vibtra.app/api/auth/callback/google");
  });

  it("points at the dashboard and landing the image builds, not at the old console", async () => {
    const image = await guardDockerfile();
    expect(image.text).toContain("pnpm --filter @vibtra/guard-console build");
    expect(image.text).toContain("pnpm --filter @vibtra/landing build");
    expect(image.text).toContain("WORKDIR /app/apps/registry");
    const env = envOf(container((await synth()).registry, "registry"));
    expect(env["VIBTRA_GUARD_CONSOLE_DIST"]).toBe("/app/apps/guard-console/dist");
    expect(env["VIBTRA_LANDING_DIST"]).toBe("/app/apps/landing/dist");
    expect(env).not.toHaveProperty("VIBTRA_CONSOLE_DIST");
  });

  it("runs on x86_64 Linux, the platform the image is built for", async () => {
    const tasks = taskDefinitions((await synth()).registry);
    expect(tasks).toHaveLength(2);
    for (const task of tasks) {
      expect(task["RuntimePlatform"]).toEqual({ CpuArchitecture: "X86_64", OperatingSystemFamily: "LINUX" });
    }
  });
});
