import { readFile } from "node:fs/promises";
import { beforeAll, describe, expect, it } from "vitest";
import { synth, type CfnTemplate } from "./synth.js";

const STATEFUL_TYPES: Readonly<Record<string, "all" | readonly string[]>> = {
  "AWS::RDS::DBInstance": "all",
  "AWS::RDS::DBSubnetGroup": "all",
  "AWS::SecretsManager::Secret": "all",
  "AWS::SecretsManager::SecretTargetAttachment": "all",
  "AWS::KMS::Key": "all",
  "AWS::EC2::VPC": "all",
  "AWS::EC2::Subnet": "all",
  "AWS::EC2::EIP": "all",
  "AWS::EC2::NatGateway": "all",
  "AWS::EC2::SecurityGroup": ["GroupDescription", "GroupName", "VpcId"],
  "AWS::CloudFront::Distribution": "all",
  "AWS::CertificateManager::Certificate": "all",
  "AWS::Logs::LogGroup": "all",
  "AWS::ECR::Repository": "all",
  "AWS::Route53::RecordSet": "all",
  "AWS::ElasticLoadBalancingV2::LoadBalancer": "all",
  "AWS::ECS::Cluster": "all",
  "AWS::ECS::Service": ["Cluster", "LaunchType", "ServiceName", "LoadBalancers"],
};

const DEPLOYED_SHAPE: Record<string, string> = {
  imageTag: "guard-v0.0.0-test",
  domainName: "vibtra.app",
  hostedZoneId: "Z0000000000000EXAMPLE",
  hostedZoneName: "vibtra.app",
  googleClientId: "example.apps.googleusercontent.com",
  googleClientSecretArn: "arn:aws:secretsmanager:ap-southeast-2:123456789012:secret:example-google-client-AbCdEf",
  certificateArn: "arn:aws:acm:ap-southeast-2:123456789012:certificate/00000000-0000-4000-8000-000000000001",
  edgeCertificateArn: "arn:aws:acm:us-east-1:123456789012:certificate/00000000-0000-4000-8000-000000000002",
};

interface StatefulEntry {
  type: string;
  properties: Record<string, unknown>;
  deletionPolicy?: string;
  updateReplacePolicy?: string;
}

type Snapshot = Record<string, StatefulEntry>;
type Stack = "VibtraRegistry" | "VibtraRegistryEcr";

const snapshotOf = (template: CfnTemplate): Snapshot => {
  const out: Snapshot = {};
  for (const [id, resource] of Object.entries(template.Resources)) {
    const pinned = STATEFUL_TYPES[resource.Type];
    if (pinned === undefined) continue;
    const all = resource.Properties ?? {};
    out[id] = {
      type: resource.Type,
      properties: pinned === "all" ? all : Object.fromEntries(pinned.filter((k) => k in all).map((k) => [k, all[k]])),
      ...(resource.DeletionPolicy === undefined ? {} : { deletionPolicy: resource.DeletionPolicy }),
      ...(resource.UpdateReplacePolicy === undefined ? {} : { updateReplacePolicy: resource.UpdateReplacePolicy }),
    };
  }
  return out;
};

describe("stateful resources keep their deployed logical IDs when the real app synthesises the deployed shape", () => {
  let deployed: Record<Stack, Snapshot>;
  let current: Record<Stack, Snapshot>;
  let builtEdgeStack = true;

  beforeAll(async () => {
    deployed = JSON.parse(
      await readFile(new URL("./fixtures/deployed-stateful.json", import.meta.url), "utf8"),
    ) as Record<Stack, Snapshot>;
    const synthesized = await synth(DEPLOYED_SHAPE);
    builtEdgeStack = synthesized.edge !== undefined;
    current = { VibtraRegistry: snapshotOf(synthesized.registry), VibtraRegistryEcr: snapshotOf(synthesized.ecr) };
  });

  it("synthesises the deployed shape: both certificates imported by ARN, so no edge certificate stack", () => {
    expect(builtEdgeStack).toBe(false);
  });

  it("pins the resources the cutover must not touch", () => {
    const types = Object.values(deployed.VibtraRegistry).map((entry) => entry.type);
    for (const type of [
      "AWS::RDS::DBInstance",
      "AWS::SecretsManager::Secret",
      "AWS::EC2::VPC",
      "AWS::EC2::Subnet",
      "AWS::EC2::SecurityGroup",
      "AWS::CloudFront::Distribution",
      "AWS::Logs::LogGroup",
      "AWS::Route53::RecordSet",
    ]) {
      expect(types, type).toContain(type);
    }
    expect(Object.keys(deployed.VibtraRegistry).length).toBeGreaterThanOrEqual(29);
    expect(Object.values(deployed.VibtraRegistryEcr).map((entry) => entry.type)).toEqual(["AWS::ECR::Repository"]);
  });

  for (const stack of ["VibtraRegistry", "VibtraRegistryEcr"] as const) {
    it(`${stack}: no stateful logical ID disappears or changes type`, () => {
      const missing: string[] = [];
      const retyped: string[] = [];
      for (const [id, entry] of Object.entries(deployed[stack])) {
        const now = current[stack][id];
        if (now === undefined) missing.push(`${id} (${entry.type})`);
        else if (now.type !== entry.type) retyped.push(`${id}: ${entry.type} -> ${now.type}`);
      }
      expect(missing, "deleted or renamed: CloudFormation would delete these and create new ones").toEqual([]);
      expect(retyped, "changed type: CloudFormation would replace these").toEqual([]);
    });

    it(`${stack}: no stateful resource changes a pinned property or its deletion policy`, () => {
      for (const [id, entry] of Object.entries(deployed[stack])) {
        const now = current[stack][id];
        expect(now, `${id} is missing`).toBeDefined();
        expect(now?.properties, `${id} (${entry.type}) properties`).toEqual(entry.properties);
        expect(now?.deletionPolicy, `${id} DeletionPolicy`).toBe(entry.deletionPolicy);
        expect(now?.updateReplacePolicy, `${id} UpdateReplacePolicy`).toBe(entry.updateReplacePolicy);
      }
    });
  }

  it("keeps every RETAIN on the data, the keys, the egress address and the logs", () => {
    for (const id of [
      "DatabaseB269D8BB",
      "SessionSecretC41FBD23",
      "GateSigningSecretF6500153",
      "VaultKey6B75F33E",
      "ManagedConnectionEgress",
      "RegistryLogs2F995C1D",
    ]) {
      expect(current.VibtraRegistry[id]?.deletionPolicy, id).toBe("Retain");
    }
    expect(current.VibtraRegistryEcr["Repository22E53BBD"]?.deletionPolicy).toBe("Retain");
  });
});
