import { createHash, X509Certificate } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  container,
  containers,
  entryScriptOf,
  envOf,
  only,
  propertiesOf,
  refusal,
  resources,
  secretNamesOf,
  synth,
  type CfnTemplate,
} from "./synth.js";

const TLS_SECRET_ARN = "arn:aws:secretsmanager:ap-southeast-2:123456789012:secret:openbao-tls-xy9q4z";
const DB_SECRET_ARN = "arn:aws:secretsmanager:ap-southeast-2:123456789012:secret:openbao-db-role-7k2m4p";
const ROLE_ID = "EXAMPLE-not-a-real-role-id";
const RENDERED_KMS_ARN = "<cfn-ref>";
const AP_SOUTHEAST_2_RDS_BUNDLE_SHA256 = "d73890748b5a95551800df8a6f07c9c800e32ed34da7e6c9505918bf8ac2398b";

const UP = { openbaoEnabled: "true", openbaoTlsSecretArn: TLS_SECRET_ARN, openbaoDbSecretArn: DB_SECRET_ARN };
const PLAIN = { openbaoEnabled: "true", openbaoTlsDisable: "true", openbaoDbSecretArn: DB_SECRET_ARN };

const up = (extra: Record<string, string> = {}) => synth({ ...UP, ...extra });
const wired = () => up({ openbaoRoleId: ROLE_ID });
const plain = (extra: Record<string, string> = {}) => synth({ ...PLAIN, ...extra });

const baoConfig = (template: CfnTemplate): Record<string, unknown> => {
  const raw = envOf(container(template, "openbao"))["BAO_LOCAL_CONFIG"] as { "Fn::Join": [string, unknown[]] };
  const text = raw["Fn::Join"][1].map((part) => (typeof part === "string" ? part : RENDERED_KMS_ARN)).join("");
  return JSON.parse(text) as Record<string, unknown>;
};

const baoSecurityGroup = (template: CfnTemplate) => {
  const found = resources(template, "AWS::EC2::SecurityGroup").filter(([id]) => id.startsWith("OpenBaoServiceSecurityGroup"));
  const first = found[0];
  if (found.length !== 1 || first === undefined) throw new Error(`expected one OpenBao security group, found ${found.length}`);
  return first;
};

const rulesPointedAt = (template: CfnTemplate, type: string, groupId: string): Array<Record<string, unknown>> =>
  resources(template, type)
    .map(([, rule]) => propertiesOf(rule))
    .filter((rule) => JSON.stringify(rule["GroupId"] ?? "").includes(groupId));

describe("OpenBao is absent unless it is asked for", () => {
  it("creates no OpenBao resource and wires nothing into the registry in the default shape", async () => {
    const { registry } = await synth();
    expect(resources(registry, "AWS::KMS::Key")).toHaveLength(0);
    expect(resources(registry, "AWS::ServiceDiscovery::PrivateDnsNamespace")).toHaveLength(0);
    expect(resources(registry, "AWS::ServiceDiscovery::Service")).toHaveLength(0);
    expect(resources(registry, "AWS::ECS::Service")).toHaveLength(1);
    expect(containers(registry).map((c) => c.Name).sort()).toEqual(["registry", "reseal"]);
    expect(Object.keys(envOf(container(registry, "registry"))).filter((k) => k.startsWith("OPENBAO_"))).toEqual([]);
    expect(secretNamesOf(container(registry, "registry"))).not.toContain("OPENBAO_SECRET_ID");
  });

  it("keeps the CA-staging branch in both entry points, inert because nothing sets OPENBAO_CA_CERT", async () => {
    const { registry } = await synth();
    for (const name of ["registry", "reseal"]) {
      const entry = container(registry, name).EntryPoint?.join(" ") ?? "";
      expect(entry, name).toContain('if [ -n "$OPENBAO_CA_CERT" ]');
      expect(entry, name).toContain("NODE_EXTRA_CA_CERTS=/tmp/openbao-ca.pem");
    }
    const bodies = containers(registry).map((c) => JSON.stringify({ e: c.Environment, s: c.Secrets }));
    expect(bodies.some((body) => body.includes('"OPENBAO_CA_CERT"'))).toBe(false);
  });

  it("treats unset repository variables (-c key= for every OpenBao key) as absent", async () => {
    const { registry } = await synth({ openbaoEnabled: "", openbaoTlsSecretArn: "", openbaoDbSecretArn: "", openbaoRoleId: "" });
    expect(resources(registry, "AWS::KMS::Key")).toHaveLength(0);
    expect(containers(registry).map((c) => c.Name).sort()).toEqual(["registry", "reseal"]);
  });

  it("refuses to guess about TLS", async () => {
    expect(await refusal({ openbaoEnabled: "true" })).toMatch(/openbaoTlsSecretArn|openbaoTlsDisable/);
    expect(await refusal({ ...UP, openbaoTlsDisable: "true" })).toMatch(/openbaoTlsSecretArn and openbaoTlsDisable=true contradict/);
  });

  it("refuses to wire the registry to an OpenBao it is not creating", async () => {
    expect(await refusal({ openbaoRoleId: ROLE_ID })).toMatch(/openbaoRoleId describes an OpenBao this stack is not creating/);
    expect(await refusal({ openbaoTlsSecretArn: TLS_SECRET_ARN })).toMatch(/openbaoTlsSecretArn describes an OpenBao this stack is not creating/);
  });

  it("refuses to let OpenBao connect as the RDS master user, and says what to create instead", async () => {
    const message = await refusal({ openbaoEnabled: "true", openbaoTlsSecretArn: TLS_SECRET_ARN });
    expect(message).toMatch(/openbaoDbSecretArn/);
    expect(message).toMatch(/The database role OpenBao connects as/);
    expect(message).toMatch(/CREATE ROLE openbao/);
    const both = await refusal({ openbaoEnabled: "true" });
    expect(both).toMatch(/openbaoTlsSecretArn|openbaoTlsDisable/);
    expect(both).not.toMatch(/The database role OpenBao connects as/);
  });

  it("refuses an image it cannot read as 2.6.x, and accepts a pinned tag with a digest or a mirror that keeps the version", async () => {
    const newer = await refusal({ ...UP, openbaoImage: "openbao/openbao:2.7.0" });
    expect(newer).toMatch(/plugin "kms" "awskms"/);
    expect(newer).toMatch(/openbaoSealPluginDir/);
    expect(newer).toMatch(/Upgrading past 2\.6\.x/);
    expect(await refusal({ ...UP, openbaoImage: `openbao/openbao@sha256:${"a".repeat(64)}` })).toMatch(/plugin "kms" "awskms"/);
    for (const image of [
      `openbao/openbao:2.6.2@sha256:${"a".repeat(64)}`,
      "123456789012.dkr.ecr.ap-southeast-2.amazonaws.com/vibtra-openbao:2.6.9",
    ]) {
      const { registry } = await up({ openbaoImage: image });
      expect(container(registry, "openbao").Image).toBe(image);
    }
  });
});

describe("the OpenBao service", () => {
  it("creates a retained unseal key that rotates and has an alias", async () => {
    const { registry } = await up();
    const [, key] = only(registry, "AWS::KMS::Key");
    expect(propertiesOf(key)["EnableKeyRotation"]).toBe(true);
    expect(key.DeletionPolicy).toBe("Retain");
    expect(propertiesOf(only(registry, "AWS::KMS::Alias")[1])["AliasName"]).toBe("alias/vibtra-openbao-unseal");
  });

  it("grants the OpenBao task Encrypt, Decrypt and DescribeKey in the key policy and nothing else", async () => {
    const { registry } = await up();
    const policy = propertiesOf(only(registry, "AWS::KMS::Key")[1])["KeyPolicy"] as {
      Statement: Array<{ Sid?: string; Action: string[] | string }>;
    };
    const task = policy.Statement.find((s) => s.Sid === "OpenBaoTaskAutoUnseal");
    expect(task, "the key policy has no statement for the OpenBao task role").toBeDefined();
    expect([task?.Action].flat().sort()).toEqual(["kms:Decrypt", "kms:DescribeKey", "kms:Encrypt"]);
  });

  it("configures the awskms seal and the postgresql storage, and puts no credential in the config", async () => {
    const config = baoConfig((await up()).registry);
    expect(config["seal"]).toEqual({ awskms: { region: "ap-southeast-2", kms_key_id: RENDERED_KMS_ARN } });
    expect(config["storage"]).toEqual({
      postgresql: { table: "openbao_kv_store", ha_table: "openbao_ha_locks", ha_enabled: "true", skip_create_table: "true" },
    });
    expect(config["disable_mlock"]).toBe(true);
    const rendered = JSON.stringify(config);
    expect(rendered).not.toContain("connection_url");
    expect(rendered).not.toContain("password");
  });

  it("carries no seal plugin on 2.6.x, and both plugin halves with an unchanged seal when one is staged", async () => {
    const shipped = baoConfig((await up()).registry);
    expect(shipped).not.toHaveProperty("plugin");
    expect(shipped).not.toHaveProperty("plugin_directory");
    const staged = baoConfig((await up({ openbaoImage: "openbao/openbao:2.7.0", openbaoSealPluginDir: "/openbao/plugins" })).registry);
    expect(staged["plugin_directory"]).toBe("/openbao/plugins");
    expect(staged["plugin"]).toEqual({ kms: { awskms: {} } });
    expect(staged["seal"]).toEqual(shipped["seal"]);
  });

  it("renders repeated HCL blocks as arrays of single-key objects and sets the addresses HA needs", async () => {
    const config = baoConfig((await up()).registry);
    const listeners = config["listener"] as Array<{ tcp: Record<string, unknown> }>;
    expect(Array.isArray(listeners)).toBe(true);
    expect(listeners.map((l) => l.tcp["address"])).toEqual(["0.0.0.0:8200", "127.0.0.1:8210"]);
    expect(listeners[1]?.tcp["tls_disable"]).toBe(true);
    expect(config["audit"]).toEqual({ file: { "to-stdout": { options: [{ file_path: "stdout" }] } } });
    expect(config["api_addr"]).toBe("https://openbao.vibtra.internal:8200");
    expect(config["cluster_addr"]).toBe("https://openbao.vibtra.internal:8201");
  });

  it("never creates its own tables and connects as the least-privilege role, not the registry's master user", async () => {
    const { registry } = await up();
    const storage = baoConfig(registry)["storage"] as { postgresql: Record<string, unknown> };
    expect(storage.postgresql["skip_create_table"]).toBe("true");
    const secrets = Object.fromEntries(
      (container(registry, "openbao").Secrets ?? []).map((s) => [s.Name, JSON.stringify(s.ValueFrom)]),
    );
    for (const name of ["PGUSER", "PGPASSWORD"]) {
      expect(secrets[name], name).toContain("openbao-db-role-7k2m4p");
      expect(secrets[name], name).not.toMatch(/DatabaseSecret/);
    }
  });

  it("drops the shared addresses above one task and lets each task derive its own from eth0", async () => {
    const many = (await up({ openbaoDesiredCount: "3" })).registry;
    const config = baoConfig(many);
    expect(config["api_addr"]).toBeUndefined();
    expect(config["cluster_addr"]).toBeUndefined();
    expect(envOf(container(many, "openbao"))).toMatchObject({ BAO_REDIRECT_INTERFACE: "eth0", BAO_CLUSTER_INTERFACE: "eth0" });
    expect(Object.keys(envOf(container((await up()).registry, "openbao")))).not.toContain("BAO_REDIRECT_INTERFACE");
  });

  it("runs the real server, not the image's dev server, in both TLS modes", async () => {
    const withoutTls = container((await plain()).registry, "openbao");
    const withTls = container((await up()).registry, "openbao");
    for (const bao of [withoutTls, withTls]) {
      expect(bao.Image).toBe("openbao/openbao:2.6.2");
      expect(bao.EntryPoint?.[0]).toBe("/bin/sh");
      expect(bao.Command).toEqual(["docker-entrypoint.sh", "server"]);
      expect(JSON.stringify(bao.Command)).not.toContain("-dev");
      expect(entryScriptOf(bao)).toContain('exec "$0" "$@"');
      expect(entryScriptOf(bao)).toContain("$RDS_CA_BUNDLE");
    }
    expect(entryScriptOf(withoutTls)).not.toContain("OPENBAO_TLS_KEY");
    expect(entryScriptOf(withTls)).toContain("$OPENBAO_TLS_KEY");
  });

  it("injects the listener key and the database role as task secrets and keeps only facts in the environment", async () => {
    const bao = container((await up()).registry, "openbao");
    expect(secretNamesOf(bao).sort()).toEqual(["OPENBAO_TLS_CERT", "OPENBAO_TLS_KEY", "PGPASSWORD", "PGUSER"]);
    expect(Object.keys(envOf(bao)).sort()).toEqual([
      "BAO_LOCAL_CONFIG",
      "PGDATABASE",
      "PGHOST",
      "PGPORT",
      "PGSSLMODE",
      "PGSSLROOTCERT",
      "RDS_CA_BUNDLE",
    ]);
  });

  it("verifies the RDS server certificate with verify-full and a CA file the entry point writes before the server starts", async () => {
    for (const registry of [(await up()).registry, (await plain()).registry]) {
      const bao = container(registry, "openbao");
      const env = envOf(bao);
      expect(env["PGSSLMODE"]).toBe("verify-full");
      const root = env["PGSSLROOTCERT"];
      expect(typeof root).toBe("string");
      const entry = entryScriptOf(bao);
      expect(entry).toContain(`printf '%s\\n' "$RDS_CA_BUNDLE" > ${String(root)}`);
      expect(entry.indexOf("$RDS_CA_BUNDLE")).toBeLessThan(entry.indexOf('exec "$0"'));
      expect(String(env["RDS_CA_BUNDLE"])).toContain("-----BEGIN CERTIFICATE-----");
    }
  });

  it("vendors the regional RDS roots that AWS publishes and pins the instance to the root family they contain", async () => {
    const { registry } = await up();
    const bundle = String(envOf(container(registry, "openbao"))["RDS_CA_BUNDLE"]);
    expect(createHash("sha256").update(bundle, "utf8").digest("hex")).toBe(AP_SOUTHEAST_2_RDS_BUNDLE_SHA256);
    const certs = (bundle.match(/-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g) ?? []).map(
      (pem) => new X509Certificate(pem),
    );
    expect(certs).toHaveLength(3);
    for (const cert of certs) {
      expect(cert.issuer).toBe(cert.subject);
      expect(new Date(cert.validTo).getTime()).toBeGreaterThan(Date.now());
      expect(cert.subject).toContain("CN=Amazon RDS ap-southeast-2 Root CA");
    }
    const pinned = String(propertiesOf(only(registry, "AWS::RDS::DBInstance")[1])["CACertificateIdentifier"]);
    expect(pinned).toBe("rds-ca-rsa2048-g1");
    const family = pinned.replace(/^rds-ca-/, "").replace("-", " ").toUpperCase();
    expect(certs.map((c) => c.subject).join("\n")).toContain(`CN=Amazon RDS ap-southeast-2 Root CA ${family}`);
  });

  it("keeps the OpenBao task definition under the 64 KiB RegisterTaskDefinition ceiling", async () => {
    const task = resources((await up()).registry, "AWS::ECS::TaskDefinition").find(([, t]) =>
      JSON.stringify(propertiesOf(t)).includes('"Name":"openbao"'),
    );
    expect(task, "no task definition holds the openbao container").toBeDefined();
    expect(Buffer.byteLength(JSON.stringify(propertiesOf(task?.[1])), "utf8")).toBeLessThan(64 * 1024);
  });

  it("refuses a region whose RDS roots nobody vendored, with or without OpenBao", async () => {
    expect(await refusal({ ...UP, region: "us-east-1" })).toMatch(/no Amazon RDS CA bundle is vendored for us-east-1/);
    expect(await refusal({ region: "us-east-1" })).toMatch(/no Amazon RDS CA bundle is vendored for us-east-1/);
  });

  it("health-checks an uninitialised or sealed node over the loopback listener", async () => {
    const check = container((await up()).registry, "openbao").HealthCheck?.Command.join(" ") ?? "";
    expect(check).toContain("uninitcode=200");
    expect(check).toContain("sealedcode=200");
    expect(check).toContain("standbyok=true");
    expect(check).toContain("http://127.0.0.1:8210/");
  });

  it("is internal only: a private DNS name, no load balancer of its own, no public IP", async () => {
    const { registry } = await up();
    expect(propertiesOf(only(registry, "AWS::ServiceDiscovery::PrivateDnsNamespace")[1])["Name"]).toBe("vibtra.internal");
    expect(propertiesOf(only(registry, "AWS::ServiceDiscovery::Service")[1])["Name"]).toBe("openbao");
    expect(resources(registry, "AWS::ElasticLoadBalancingV2::LoadBalancer")).toHaveLength(1);
    expect(resources(registry, "AWS::ElasticLoadBalancingV2::Listener")).toHaveLength(1);
    expect(resources(registry, "AWS::ElasticLoadBalancingV2::TargetGroup")).toHaveLength(1);
    const services = resources(registry, "AWS::ECS::Service").filter(([id]) => id.startsWith("OpenBaoService"));
    expect(services).toHaveLength(1);
    const service = propertiesOf(services[0]?.[1]);
    expect(service["ServiceRegistries"]).toBeDefined();
    expect(service["LoadBalancers"]).toBeUndefined();
    expect(service).toMatchObject({ NetworkConfiguration: { AwsvpcConfiguration: { AssignPublicIp: "DISABLED" } } });
  });

  it("admits exactly one source on 8200, the registry's own security group", async () => {
    const { registry } = await up();
    const [groupId] = baoSecurityGroup(registry);
    const ingress = rulesPointedAt(registry, "AWS::EC2::SecurityGroupIngress", groupId);
    expect(ingress).toHaveLength(1);
    expect(ingress[0]).toMatchObject({ FromPort: 8200, ToPort: 8200 });
    expect(ingress[0]?.["CidrIp"]).toBeUndefined();
    expect(JSON.stringify(ingress[0]?.["SourceSecurityGroupId"])).toContain("ServiceSecurityGroup");
  });

  it("declares its egress instead of inheriting the allow-all placeholder, and keeps the rule to Postgres", async () => {
    const { registry } = await up();
    const [groupId, group] = baoSecurityGroup(registry);
    const egress = (propertiesOf(group)["SecurityGroupEgress"] as Array<Record<string, unknown>> | undefined) ?? [];
    expect(egress).toEqual([expect.objectContaining({ IpProtocol: "tcp", CidrIp: "0.0.0.0/0", FromPort: 1, ToPort: 65535 })]);
    expect(JSON.stringify(egress)).not.toContain("Allow all outbound traffic by default");
    const toDatabase = rulesPointedAt(registry, "AWS::EC2::SecurityGroupEgress", groupId);
    expect(toDatabase).toHaveLength(1);
    expect(JSON.stringify(toDatabase[0])).toContain("openbao to postgres");
  });

  it("opens the cluster port to itself only when there is a second node", async () => {
    const one = (await up()).registry;
    expect(rulesPointedAt(one, "AWS::EC2::SecurityGroupIngress", baoSecurityGroup(one)[0]).map((r) => r["FromPort"])).toEqual([8200]);
    const many = (await up({ openbaoDesiredCount: "3" })).registry;
    const [manyGroupId] = baoSecurityGroup(many);
    const rules = rulesPointedAt(many, "AWS::EC2::SecurityGroupIngress", manyGroupId);
    expect(rules.map((r) => r["FromPort"]).sort()).toEqual([8200, 8201]);
    const cluster = rules.find((r) => r["FromPort"] === 8201);
    expect(JSON.stringify(cluster?.["SourceSecurityGroupId"])).toContain(manyGroupId);
  });

  it("replaces its one task rather than running two actives", async () => {
    const services = resources((await up()).registry, "AWS::ECS::Service").filter(([id]) => id.startsWith("OpenBaoService"));
    expect(services).toHaveLength(1);
    expect(propertiesOf(services[0]?.[1])["DeploymentConfiguration"]).toMatchObject({ MinimumHealthyPercent: 0, MaximumPercent: 100 });
  });
});

describe("the registry, once OpenBao is wired", () => {
  it("is not wired until the bootstrap has produced a role id", async () => {
    const registry = container((await up()).registry, "registry");
    expect(Object.keys(envOf(registry))).not.toContain("OPENBAO_ADDR");
    expect(secretNamesOf(registry)).not.toContain("OPENBAO_SECRET_ID");
  });

  it("gives the registry and reseal tasks the address and role id as values and the secret id as a secret", async () => {
    const { registry } = await wired();
    for (const name of ["registry", "reseal"]) {
      const c = container(registry, name);
      expect(envOf(c), name).toMatchObject({ OPENBAO_ADDR: "https://openbao.vibtra.internal:8200", OPENBAO_ROLE_ID: ROLE_ID });
      expect(secretNamesOf(c), name).toEqual(expect.arrayContaining(["OPENBAO_SECRET_ID", "VIBTRA_VAULT_KEY"]));
      expect(Object.keys(envOf(c)), name).not.toContain("OPENBAO_SECRET_ID");
    }
  });

  it("stages the listener's CA so both tasks verify OpenBao's certificate, and still compose the DSN", async () => {
    const { registry } = await wired();
    for (const name of ["registry", "reseal"]) {
      const c = container(registry, name);
      expect(secretNamesOf(c), name).toContain("OPENBAO_CA_CERT");
      const script = (c.EntryPoint ?? []).join(" ");
      expect(script).toContain("NODE_EXTRA_CA_CERTS");
      expect(script).toContain("umask 077");
      expect(script).toContain("export DATABASE_URL=");
      expect(script).toContain('exec guard-entrypoint "$0" "$@"');
    }
  });

  it("speaks plain HTTP and stages no CA when TLS was explicitly disabled", async () => {
    const c = container((await plain({ openbaoRoleId: ROLE_ID })).registry, "registry");
    expect(envOf(c)["OPENBAO_ADDR"]).toBe("http://openbao.vibtra.internal:8200");
    expect(secretNamesOf(c)).not.toContain("OPENBAO_CA_CERT");
  });

  it("publishes what the operator needs and no value of anything", async () => {
    const { registry } = await wired();
    expect(Object.keys(registry.Outputs)).toEqual(
      expect.arrayContaining(["OpenBaoUnsealKeyArn", "OpenBaoSecretIdArn", "OpenBaoAddress", "OpenBaoServiceName"]),
    );
    const json = JSON.stringify(registry.Outputs);
    expect(json).not.toContain(ROLE_ID);
    expect(json).not.toMatch(/SecretString/);
  });
});
