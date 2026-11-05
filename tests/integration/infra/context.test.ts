import { describe, expect, it } from "vitest";
import { container, distributionOf, envOf, refusal, synth } from "./synth.js";

const EDGE_CERT_SYDNEY = "arn:aws:acm:ap-southeast-2:123456789012:certificate/0f7c3a2e-not-a-real-id";

describe("the CDK app reads its context the same way for every operator", () => {
  it("puts the regional stacks in ap-southeast-2 and the edge certificate stack in us-east-1, with no account", async () => {
    const { environments } = await synth();
    expect(environments).toEqual({
      VibtraRegistryEcr: "aws://unknown-account/ap-southeast-2",
      VibtraRegistryEdgeCertificate: "aws://unknown-account/us-east-1",
      VibtraRegistry: "aws://unknown-account/ap-southeast-2",
    });
  });

  it("ignores CDK_DEFAULT_REGION from the operator's shell and obeys -c region", async () => {
    const fromShell = await synth({}, { CDK_DEFAULT_REGION: "us-east-1" });
    expect(fromShell.environments["VibtraRegistry"]).toBe("aws://unknown-account/ap-southeast-2");
    expect(fromShell.environments["VibtraRegistryEcr"]).toBe("aws://unknown-account/ap-southeast-2");
    const fromContext = await refusal({ region: "eu-west-1" }, { CDK_DEFAULT_REGION: "us-east-1" });
    expect(fromContext).toMatch(/no Amazon RDS CA bundle is vendored for eu-west-1/);
  });

  it("refuses a certificate ARN that is not a certificate ARN", async () => {
    expect(await refusal({ certificateArn: "arn:aws:acm:oops" })).toMatch(/certificateArn: expected an ACM certificate ARN/);
  });

  it("refuses half a hosted zone, either half", async () => {
    expect(await refusal({ hostedZoneId: "Z0123ABCDEF" })).toMatch(/hostedZoneId and hostedZoneName are given together or not at all/);
    expect(await refusal({ hostedZoneName: "example.test" })).toMatch(/hostedZoneId and hostedZoneName are given together or not at all/);
  });

  it("treats an empty -c domainName= as absent, so the host stays the apex", async () => {
    const { registry } = await synth({ domainName: "" });
    expect(envOf(container(registry, "registry"))["REGISTRY_BASE_URL"]).toBe("https://vibtra.app");
    expect(distributionOf(registry).Aliases).toEqual(["vibtra.app", "www.vibtra.app"]);
  });

  it("refuses an edge certificate outside us-east-1, naming its region, the reason and the stack that requests one", async () => {
    const message = await refusal({ edgeCertificateArn: EDGE_CERT_SYDNEY });
    expect(message).toMatch(/edgeCertificateArn is in ap-southeast-2.*only from us-east-1/);
    expect(message).toMatch(/VibtraRegistryEdgeCertificate/);
  });

  it("checks the edge certificate ARN's shape before its region", async () => {
    const message = await refusal({ edgeCertificateArn: "arn:aws:acm:oops" });
    expect(message).toMatch(/edgeCertificateArn: expected an ACM certificate ARN/);
    expect(message).not.toMatch(/CloudFront accepts a viewer certificate only from/);
  });
});

describe("the one host", () => {
  it("defaults to the apex and gives the container, the outputs and the Google callback that one name", async () => {
    const { registry } = await synth();
    expect(envOf(container(registry, "registry"))["REGISTRY_BASE_URL"]).toBe("https://vibtra.app");
    expect(registry.Outputs["RegistryUrl"]?.Value).toBe("https://vibtra.app");
    expect(registry.Outputs["GoogleRedirectUri"]?.Value).toBe("https://vibtra.app/api/auth/callback/google");
  });
});
