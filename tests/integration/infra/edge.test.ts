import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";
import { distributionOf, only, propertiesOf, resources, synth, type CfnTemplate, type Synthesized } from "./synth.js";

const EDGE_CERT_US_EAST_1 = "arn:aws:acm:us-east-1:123456789012:certificate/0f7c3a2e-not-a-real-id";
const ZONE = { hostedZoneId: "Z0123456789ABCDEFGHIJ", hostedZoneName: "vibtra.app" };
const CACHING_DISABLED = "4135ea2d-6df8-44a3-9df3-4b5a84be39ad";
const CACHING_OPTIMIZED = "658327ea-f89d-4fab-a63d-7e88639e58f6";
const ALL_VIEWER = "216adef6-5c7f-47e4-b989-5492eafa07d3";

interface FunctionValue {
  readonly value: string;
  readonly multiValue?: Array<{ readonly value: string }>;
}

interface FunctionRequest {
  readonly method: string;
  readonly uri: string;
  readonly querystring: Record<string, FunctionValue>;
  readonly headers: Record<string, FunctionValue>;
}

interface FunctionRedirect {
  readonly statusCode: number;
  readonly statusDescription?: string;
  readonly headers: Record<string, { readonly value: string }>;
}

type ViewerRequestHandler = (event: { request: FunctionRequest }) => FunctionRedirect | FunctionRequest;

const edgeOf = (synthesized: Synthesized): CfnTemplate => {
  if (synthesized.edge === undefined) throw new Error("the app built no VibtraRegistryEdgeCertificate stack");
  return synthesized.edge;
};

const wwwRedirect = (template: CfnTemplate) =>
  propertiesOf(only(template, "AWS::CloudFront::Function")[1]) as {
    FunctionCode: string;
    FunctionConfig: { Comment?: string; Runtime?: string };
    AutoPublish?: boolean;
  };

const handlerOf = (code: string): ViewerRequestHandler => {
  const sandbox: { handler?: ViewerRequestHandler } = {};
  runInNewContext(`"use strict";\n${code}`, sandbox);
  if (sandbox.handler === undefined) throw new Error("the uploaded function code defines no handler");
  return sandbox.handler;
};

const viewerRequest = (
  host: string | undefined,
  uri: string,
  querystring: Record<string, FunctionValue> = {},
): { request: FunctionRequest } => {
  const headers: Record<string, FunctionValue> = host === undefined ? {} : { host: { value: host } };
  return { request: { method: "GET", uri, querystring, headers } };
};

const locationOf = (result: FunctionRedirect | FunctionRequest): string | undefined =>
  "statusCode" in result ? result.headers["location"]?.value : undefined;

describe("the edge certificate lives in us-east-1, by stack or by ARN", () => {
  it("requests one certificate for the apex and www in a us-east-1 stack that holds nothing else", async () => {
    const edge = edgeOf(await synth());
    const [, certificate] = only(edge, "AWS::CertificateManager::Certificate");
    expect(propertiesOf(certificate)).toMatchObject({
      DomainName: "vibtra.app",
      ValidationMethod: "DNS",
      SubjectAlternativeNames: ["www.vibtra.app"],
    });
    expect(propertiesOf(certificate)["DomainValidationOptions"]).toBeUndefined();
    for (const type of new Set(Object.values(edge.Resources).map((r) => r.Type))) {
      expect(type).not.toMatch(/RDS|ECS|Secrets|Logs::LogGroup|S3::Bucket|DynamoDB|EFS/);
    }
  });

  it("validates both names through the zone when one is given", async () => {
    const [, certificate] = only(edgeOf(await synth(ZONE)), "AWS::CertificateManager::Certificate");
    expect(propertiesOf(certificate)["DomainValidationOptions"]).toEqual([
      { DomainName: "vibtra.app", HostedZoneId: "Z0123456789ABCDEFGHIJ" },
      { DomainName: "www.vibtra.app", HostedZoneId: "Z0123456789ABCDEFGHIJ" },
    ]);
  });

  it("hands the requested certificate to the distribution across regions, and imports a given ARN without an edge stack", async () => {
    const requested = await synth();
    const viewer = distributionOf(requested.registry).ViewerCertificate;
    expect(viewer?.AcmCertificateArn).toBeDefined();
    expect(typeof viewer?.AcmCertificateArn).not.toBe("string");
    expect(JSON.stringify(viewer?.AcmCertificateArn)).toMatch(/ExportsReader|Fn::GetAtt/);
    expect(JSON.stringify(requested.registry)).toContain("VibtraRegistryEdgeCertificate");
    const imported = await synth({ edgeCertificateArn: EDGE_CERT_US_EAST_1 });
    expect(imported.edge).toBeUndefined();
    expect(Object.keys(imported.environments).sort()).toEqual(["VibtraRegistry", "VibtraRegistryEcr"]);
    expect(distributionOf(imported.registry).ViewerCertificate?.AcmCertificateArn).toBe(EDGE_CERT_US_EAST_1);
    expect(JSON.stringify(imported.registry)).not.toContain("ExportsReader");
  });
});

describe("the CloudFront distribution in front of the load balancer", () => {
  it("serves the apex and www over TLS 1.2 (2021), SNI, HTTP/2 and 3, IPv6, from every edge location", async () => {
    const d = distributionOf((await synth()).registry);
    expect(d.Enabled).toBe(true);
    expect(d.Aliases).toEqual(["vibtra.app", "www.vibtra.app"]);
    expect(d.ViewerCertificate?.MinimumProtocolVersion).toBe("TLSv1.2_2021");
    expect(d.ViewerCertificate?.SslSupportMethod).toBe("sni-only");
    expect(d.HttpVersion).toBe("http2and3");
    expect(d.IPV6Enabled).toBe(true);
    expect(d.PriceClass).toBe("PriceClass_All");
  });

  it("has the load balancer as its only origin, over HTTPS and TLS 1.2, with 60 s timeouts the load balancer outlives", async () => {
    const { registry } = await synth();
    const d = distributionOf(registry);
    expect(d.Origins).toHaveLength(1);
    const [origin] = d.Origins;
    expect(JSON.stringify(origin?.DomainName)).toMatch(/DNSName/);
    expect(origin?.CustomOriginConfig).toMatchObject({
      OriginProtocolPolicy: "https-only",
      OriginSSLProtocols: ["TLSv1.2"],
      OriginReadTimeout: 60,
      OriginKeepaliveTimeout: 60,
    });
    for (const behaviour of [d.DefaultCacheBehavior, ...(d.CacheBehaviors ?? [])]) expect(behaviour.TargetOriginId).toBe(origin?.Id);
    const attributes = propertiesOf(only(registry, "AWS::ElasticLoadBalancingV2::LoadBalancer")[1])["LoadBalancerAttributes"];
    expect(attributes).toEqual(expect.arrayContaining([{ Key: "idle_timeout.timeout_seconds", Value: "65" }]));
  });

  it("passes everything dynamic straight through: all methods, no caching, every viewer header, HTTPS redirect", async () => {
    const b = distributionOf((await synth()).registry).DefaultCacheBehavior;
    expect(b.PathPattern).toBeUndefined();
    expect([...(b.AllowedMethods ?? [])].sort()).toEqual(["DELETE", "GET", "HEAD", "OPTIONS", "PATCH", "POST", "PUT"]);
    expect(b.CachePolicyId).toBe(CACHING_DISABLED);
    expect(b.OriginRequestPolicyId).toBe(ALL_VIEWER);
    expect(b.ViewerProtocolPolicy).toBe("redirect-to-https");
  });

  it("caches only /assets/* and /landing/* at the edge, as long as the origin's Cache-Control says", async () => {
    const statics = distributionOf((await synth()).registry).CacheBehaviors ?? [];
    expect(statics.map((b) => b.PathPattern).sort()).toEqual(["/assets/*", "/landing/*"]);
    for (const b of statics) {
      expect([...(b.AllowedMethods ?? [])].sort()).toEqual(["GET", "HEAD"]);
      expect(b.Compress).toBe(true);
      expect(b.CachePolicyId).toBe(CACHING_OPTIMIZED);
      expect(b.OriginRequestPolicyId).toBe(ALL_VIEWER);
      expect(b.ViewerProtocolPolicy).toBe("redirect-to-https");
    }
  });

  it("never keeps an origin error at the edge and never replaces the origin's error page", async () => {
    const errors = distributionOf((await synth()).registry).CustomErrorResponses ?? [];
    expect(errors.map((e) => e.ErrorCode).sort((a, b) => a - b)).toEqual([400, 403, 404, 405, 414, 416, 500, 501, 502, 503, 504]);
    for (const e of errors) {
      expect(e.ErrorCachingMinTTL, `status ${e.ErrorCode}`).toBe(0);
      expect(e.ResponsePagePath).toBeUndefined();
      expect(e.ResponseCode).toBeUndefined();
    }
  });

  it("closes the load balancer to everything but CloudFront's origin-facing prefix list on 443", async () => {
    const { registry } = await synth();
    const groups = resources(registry, "AWS::EC2::SecurityGroup").filter(([id]) => id.startsWith("ServiceLBSecurityGroup"));
    expect(groups).toHaveLength(1);
    const [lbGroupId, lbGroup] = groups[0] ?? ["<none>", undefined];
    expect(propertiesOf(lbGroup)["SecurityGroupIngress"] ?? []).toEqual([]);
    const ingress = resources(registry, "AWS::EC2::SecurityGroupIngress")
      .map(([, r]) => propertiesOf(r))
      .filter((r) => JSON.stringify(r["GroupId"]).includes(lbGroupId));
    expect(ingress).toHaveLength(1);
    expect(ingress[0]).toMatchObject({ IpProtocol: "tcp", FromPort: 443, ToPort: 443 });
    expect(ingress[0]?.["CidrIp"]).toBeUndefined();
    expect(JSON.stringify(ingress[0]?.["SourcePrefixListId"])).toContain("CloudFrontOriginFacingPrefixList");
    expect(JSON.stringify(registry).match(/SourcePrefixListId/g)).toHaveLength(1);
    for (const [, rule] of resources(registry, "AWS::EC2::SecurityGroupIngress")) expect(propertiesOf(rule)["FromPort"]).not.toBe(80);
  });

  it("resolves the IPv4 prefix list by name at deploy time with one read-only EC2 action and no account at synth", async () => {
    const { registry } = await synth();
    const lookups = resources(registry, "Custom::VibtraCloudFrontPrefixList");
    expect(lookups).toHaveLength(1);
    const lookup = propertiesOf(lookups[0]?.[1]);
    const call = JSON.stringify(lookup["Update"] ?? lookup["Create"]);
    expect(call).toContain("DescribeManagedPrefixLists");
    expect(call).toContain("com.amazonaws.global.cloudfront.origin-facing");
    expect(call).toContain("prefix-list-name");
    expect(call).not.toContain("ipv6");
    expect(lookup["InstallLatestAwsSdk"]).toBe(false);
    const statements = resources(registry, "AWS::IAM::Policy").flatMap(([, policy]) => {
      const document = propertiesOf(policy)["PolicyDocument"] as { Statement: Array<{ Action: string | string[] }> };
      return document.Statement;
    });
    const ec2 = statements.filter((s) => JSON.stringify(s.Action).includes("ec2:"));
    expect(ec2).toHaveLength(1);
    expect([ec2[0]?.Action].flat()).toEqual(["ec2:DescribeManagedPrefixLists"]);
    expect(JSON.stringify(registry)).not.toMatch(/\b\d{12}\b/);
  });

  it("publishes the two edge outputs and describes the load balancer's DNS name as the origin, not a public address", async () => {
    const { registry } = await synth();
    const [distributionId] = only(registry, "AWS::CloudFront::Distribution");
    expect(JSON.stringify(registry.Outputs["EdgeDistributionId"]?.Value)).toContain(distributionId);
    expect(JSON.stringify(registry.Outputs["EdgeDistributionDomainName"]?.Value)).toContain(distributionId);
    expect(JSON.stringify(registry.Outputs["EdgeDistributionDomainName"]?.Value)).toContain("DomainName");
    expect(registry.Outputs["LoadBalancerDns"]?.Description).toMatch(/origin/i);
    expect(registry.Outputs["LoadBalancerDns"]?.Description).toMatch(/not a public address/i);
    expect(registry.Outputs["RegistryUrl"]?.Value).toBe("https://vibtra.app");
    expect(registry.Outputs["GoogleRedirectUri"]?.Value).toBe("https://vibtra.app/api/auth/callback/google");
  });
});

describe("www.vibtra.app redirects to the apex", () => {
  it("runs one published viewer-request function, pinned to runtime 2.0, on every behaviour", async () => {
    const { registry } = await synth();
    const fn = wwwRedirect(registry);
    expect(fn.FunctionConfig.Runtime).toBe("cloudfront-js-2.0");
    expect(fn.FunctionConfig.Comment).toContain("301 www.vibtra.app to vibtra.app");
    expect(fn.AutoPublish).toBe(true);
    const d = distributionOf(registry);
    const behaviours = [d.DefaultCacheBehavior, ...(d.CacheBehaviors ?? [])];
    expect(behaviours).toHaveLength(3);
    const arns = new Set<string>();
    for (const b of behaviours) {
      expect(b.FunctionAssociations, `behaviour ${b.PathPattern ?? "(default)"}`).toHaveLength(1);
      expect(b.FunctionAssociations?.[0]?.EventType).toBe("viewer-request");
      arns.add(JSON.stringify(b.FunctionAssociations?.[0]?.FunctionARN));
    }
    expect(arns.size, "one function, not three copies").toBe(1);
    expect([...arns][0]).toContain(only(registry, "AWS::CloudFront::Function")[0]);
  });

  it("answers www with a 301 that keeps the path and the query string as sent", async () => {
    const handler = handlerOf(wwwRedirect((await synth()).registry).FunctionCode);
    const root = handler(viewerRequest("www.vibtra.app", "/"));
    expect(root).toMatchObject({ statusCode: 301, statusDescription: "Moved Permanently" });
    expect(locationOf(root)).toBe("https://vibtra.app/");
    expect(locationOf(handler(viewerRequest("www.vibtra.app", "/login")))).toBe("https://vibtra.app/login");
    const withQuery = handler(
      viewerRequest("www.vibtra.app", "/r/rcpt_1", {
        ID: { value: "42" },
        NoValue: { value: "" },
        querymv: { value: "val1", multiValue: [{ value: "val1" }, { value: "val2,val3" }] },
      }),
    );
    expect(locationOf(withQuery)).toBe("https://vibtra.app/r/rcpt_1?ID=42&NoValue=&querymv=val1&querymv=val2,val3");
    const encoded = handler(viewerRequest("www.vibtra.app", "/api/auth/callback/google", { state: { value: "a%20b%2Fc" } }));
    expect(locationOf(encoded)).toBe("https://vibtra.app/api/auth/callback/google?state=a%20b%2Fc");
    expect(locationOf(handler(viewerRequest("WWW.Vibtra.App", "/")))).toBe("https://vibtra.app/");
  });

  it("passes every other host through untouched, so there is no loop and no second door", async () => {
    const handler = handlerOf(wwwRedirect((await synth()).registry).FunctionCode);
    for (const event of [
      viewerRequest("vibtra.app", "/login", { next: { value: "/vibtra" } }),
      viewerRequest("d111111abcdef8.cloudfront.net", "/api/auth/ok"),
      viewerRequest("www.vibtra.app.example.test", "/"),
      viewerRequest(undefined, "/"),
    ]) {
      expect(handler(event)).toBe(event.request);
    }
  });

  it("derives both names, the redirect target and the certificate SAN from -c domainName", async () => {
    const forked = await synth({ domainName: "example.test" });
    expect(distributionOf(forked.registry).Aliases).toEqual(["example.test", "www.example.test"]);
    const code = wwwRedirect(forked.registry).FunctionCode;
    expect(code).not.toContain("vibtra.app");
    expect(locationOf(handlerOf(code)(viewerRequest("www.example.test", "/login")))).toBe("https://example.test/login");
    expect(propertiesOf(only(edgeOf(forked), "AWS::CertificateManager::Certificate")[1])).toMatchObject({
      DomainName: "example.test",
      SubjectAlternativeNames: ["www.example.test"],
    });
  });
});
