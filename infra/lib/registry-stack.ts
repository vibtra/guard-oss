import {
  Annotations,
  CfnOutput,
  Duration,
  Fn,
  RemovalPolicy,
  Stack,
  type StackProps,
  Tags,
} from "aws-cdk-lib";
import * as acm from "aws-cdk-lib/aws-certificatemanager";
import * as cloudfront from "aws-cdk-lib/aws-cloudfront";
import * as origins from "aws-cdk-lib/aws-cloudfront-origins";
import * as ec2 from "aws-cdk-lib/aws-ec2";
import * as ecr from "aws-cdk-lib/aws-ecr";
import * as ecs from "aws-cdk-lib/aws-ecs";
import * as ecsPatterns from "aws-cdk-lib/aws-ecs-patterns";
import * as elbv2 from "aws-cdk-lib/aws-elasticloadbalancingv2";
import * as iam from "aws-cdk-lib/aws-iam";
import * as logs from "aws-cdk-lib/aws-logs";
import * as rds from "aws-cdk-lib/aws-rds";
import * as route53 from "aws-cdk-lib/aws-route53";
import * as route53Targets from "aws-cdk-lib/aws-route53-targets";
import * as secretsmanager from "aws-cdk-lib/aws-secretsmanager";
import * as cr from "aws-cdk-lib/custom-resources";
import type { Construct } from "constructs";
import { CLOUDFRONT_CERTIFICATE_REGION, type RegistryContext, wwwHostFor } from "./config.js";
import { RDS_CA_CERTIFICATE, rdsCaBundleForRegion } from "./rds-ca.js";
import { wwwRedirectFunctionCode } from "./www-redirect.js";

export interface VibtraRegistryStackProps extends StackProps {
  readonly context: RegistryContext;
  readonly edgeCertificate?: acm.ICertificate;
}

const CLOUDFRONT_ORIGIN_FACING_PREFIX_LIST = "com.amazonaws.global.cloudfront.origin-facing";

const EDGE_ORIGIN_TIMEOUT = Duration.seconds(60);

const ALB_IDLE_TIMEOUT = Duration.seconds(65);

const REGISTRY_RDS_CA_PATH = "/tmp/rds-ca.pem";

const COMPOSE_DATABASE_URL = [
  'export DATABASE_URL="postgres://$DB_USER:$DB_PASSWORD@$DB_HOST:$DB_PORT/$DB_NAME?sslmode=verify-full&sslrootcert=' + REGISTRY_RDS_CA_PATH + '"',
  'unset DB_PASSWORD',
].join("; ");

const STAGE_RDS_CA_FOR_NODE = [
  "umask 077",
  `printf '%s\\n' "$RDS_CA_BUNDLE" > ${REGISTRY_RDS_CA_PATH}`,
  "unset RDS_CA_BUNDLE",
].join("; ");

const GUARD_IMAGE_ENTRYPOINT = "guard-entrypoint";

const REGISTRY_ENTRY_POINT = [
  "/bin/sh",
  "-c",
  [STAGE_RDS_CA_FOR_NODE, COMPOSE_DATABASE_URL, `exec ${GUARD_IMAGE_ENTRYPOINT} "$0" "$@"`].join("; "),
];

const REGISTRY_CMD = ["node_modules/.bin/tsx", "src/main.ts"];

const TASK_RUNTIME_PLATFORM: ecs.RuntimePlatform = {
  cpuArchitecture: ecs.CpuArchitecture.X86_64,
  operatingSystemFamily: ecs.OperatingSystemFamily.LINUX,
};

const DB_PASSWORD_EXCLUDE = "\"@/\\'`$&+,:;=?#[]{}|<>^~%!*() ";

const HEX_ONLY_EXCLUDE = "ghijklmnopqrstuvwxyz";

export class VibtraRegistryStack extends Stack {
  public constructor(scope: Construct, id: string, props: VibtraRegistryStackProps) {
    super(scope, id, props);
    const ctx = props.context;

    Tags.of(this).add("vibtra:component", "registry-control-plane");
    Tags.of(this).add("vibtra:residency", ctx.region);

    const managedConnectionEgress = new ec2.CfnEIP(this, "ManagedConnectionEgress", {
      domain: "vpc",
      tags: [{ key: "Name", value: "vibtra-managed-connection-egress" }],
    });
    managedConnectionEgress.applyRemovalPolicy(RemovalPolicy.RETAIN);

    const vpc = new ec2.Vpc(this, "Vpc", {
      maxAzs: 2,
      natGateways: 1,
      natGatewayProvider: ec2.NatProvider.gateway({
        eipAllocationIds: [managedConnectionEgress.attrAllocationId],
      }),
      ipAddresses: ec2.IpAddresses.cidr("10.42.0.0/16"),
      subnetConfiguration: [
        { name: "edge", subnetType: ec2.SubnetType.PUBLIC, cidrMask: 24 },
        { name: "app", subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS, cidrMask: 22 },
        { name: "data", subnetType: ec2.SubnetType.PRIVATE_ISOLATED, cidrMask: 24 },
      ],
    });

    const db = new rds.DatabaseInstance(this, "Database", {
      engine: rds.DatabaseInstanceEngine.postgres({
        version: rds.PostgresEngineVersion.of(ctx.postgresVersion, ctx.postgresVersion.split(".")[0] ?? "16"),
      }),
      instanceType: new ec2.InstanceType(ctx.dbInstanceClass),
      vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_ISOLATED },
      publiclyAccessible: false,
      multiAz: true,
      storageEncrypted: true,
      allocatedStorage: ctx.dbAllocatedStorageGiB,
      maxAllocatedStorage: ctx.dbAllocatedStorageGiB * 10,
      backupRetention: Duration.days(ctx.backupRetentionDays),
      copyTagsToSnapshot: true,
      deletionProtection: true,
      removalPolicy: RemovalPolicy.RETAIN,
      databaseName: "vibtra_registry",
      credentials: rds.Credentials.fromGeneratedSecret("vibtra", {
        excludeCharacters: DB_PASSWORD_EXCLUDE,
      }),
      autoMinorVersionUpgrade: true,
      caCertificate: RDS_CA_CERTIFICATE,
      cloudwatchLogsExports: ["postgresql"],
      cloudwatchLogsRetention: logs.RetentionDays.ONE_MONTH,
    });
    const dbSecret = db.secret;
    if (dbSecret === undefined) {
      throw new Error("vibtra infra: the database was created without a managed secret");
    }

    const sessionSecret = new secretsmanager.Secret(this, "SessionSecret", {
      description:
        "Better Auth `secret` for the Vibtra registry — CONSOLE SESSIONS ONLY. It signs and encrypts the session " +
        "cookie. Rotating it signs everyone out of the console and they sign in again; it does NOT touch the " +
        "tool-gate signing key, which has its own secret (GateSigningSecret). Runbook: " +
        "docs/deploy-registry-aws.md §1.5.",
      generateSecretString: {
        passwordLength: 64,
        excludePunctuation: true,
        requireEachIncludedType: false,
      },
      removalPolicy: RemovalPolicy.RETAIN,
    });

    const gateSigningSecret = new secretsmanager.Secret(this, "GateSigningSecret", {
      description:
        "REGISTRY_GATE_SIGNING_SECRET for the Vibtra registry — THE TOOL GATE'S SIGNING KEY AT REST. It encrypts " +
        "the private half of every row in the `jwks` table (migration 0008), which is what signs the ID token every " +
        "deployed tool's sign-in gate verifies. Rotating it does NOT sign anyone out of the console; the key itself " +
        "is rotated with `pnpm --filter @vibtra/registry rotate-issuer-key`. Runbook: " +
        "docs/deploy-registry-aws.md §1.5.",
      generateSecretString: {
        passwordLength: 64,
        excludePunctuation: true,
        requireEachIncludedType: false,
      },
      removalPolicy: RemovalPolicy.RETAIN,
    });

    const vaultKey = new secretsmanager.Secret(this, "VaultKey", {
      description:
        "VIBTRA_VAULT_KEY — the 256-bit key every stored connector credential is sealed under. " +
        "RETAINED ON PURPOSE: destroying it makes every sealed row unrecoverable. Back it up.",
      generateSecretString: {
        passwordLength: 64,
        excludeUppercase: true,
        excludePunctuation: true,
        excludeCharacters: HEX_ONLY_EXCLUDE,
        requireEachIncludedType: false,
      },
      removalPolicy: RemovalPolicy.RETAIN,
    });

    const previousVaultKey =
      ctx.vaultKeyPreviousSecretArn === undefined
        ? undefined
        : secretsmanager.Secret.fromSecretCompleteArn(this, "VaultKeyPrevious", ctx.vaultKeyPreviousSecretArn);

    const googleClientSecret =
      ctx.googleClientSecretArn === undefined
        ? undefined
        : secretsmanager.Secret.fromSecretCompleteArn(this, "GoogleClientSecret", ctx.googleClientSecretArn);
    if (googleClientSecret === undefined) {
      Annotations.of(this).addWarning(
        "No googleClientSecretArn: the task will start with an EMPTY Google client secret and sign-in will fail with " +
          "invalid_client. Create the secret once (docs/deploy-registry-aws.md) and redeploy with -c googleClientSecretArn=…",
      );
    }

    const wwwHost = wwwHostFor(ctx.domainName);
    const hostedZone =
      ctx.hostedZoneId !== undefined && ctx.hostedZoneName !== undefined
        ? route53.HostedZone.fromHostedZoneAttributes(this, "Zone", {
            hostedZoneId: ctx.hostedZoneId,
            zoneName: ctx.hostedZoneName,
          })
        : undefined;

    const certificate =
      ctx.certificateArn !== undefined
        ? acm.Certificate.fromCertificateArn(this, "Certificate", ctx.certificateArn)
        : new acm.Certificate(this, "Certificate", {
            domainName: ctx.domainName,
            validation:
              hostedZone === undefined
                ? acm.CertificateValidation.fromDns()
                : acm.CertificateValidation.fromDns(hostedZone),
          });

    const edgeCertificate =
      ctx.edgeCertificateArn !== undefined
        ? acm.Certificate.fromCertificateArn(this, "EdgeCertificate", ctx.edgeCertificateArn)
        : props.edgeCertificate;
    if (edgeCertificate === undefined) {
      throw new Error(
        "vibtra infra: VibtraRegistryStack needs a CloudFront viewer certificate — either pass -c edgeCertificateArn=… " +
          `(a certificate in ${CLOUDFRONT_CERTIFICATE_REGION}) or construct VibtraRegistryEdgeCertificate first and hand ` +
          "its `certificate` in as `edgeCertificate`, which is what bin/vibtra-registry.ts does.",
      );
    }

    const logGroup = new logs.LogGroup(this, "RegistryLogs", {
      retention: logRetention(ctx.logRetentionDays),
      removalPolicy: RemovalPolicy.RETAIN,
    });

    const repository = ecr.Repository.fromRepositoryName(this, "Repository", ctx.ecrRepositoryName);
    const cluster = new ecs.Cluster(this, "Cluster", {
      vpc,
      containerInsightsV2: ecs.ContainerInsights.ENABLED,
    });

    const environment: Record<string, string> = {
      REGISTRY_MODE: "hosted",
      NODE_ENV: "production",
      LOG_LEVEL: ctx.logLevel,
      REGISTRY_BASE_URL: `https://${ctx.domainName}`,
      RDS_CA_BUNDLE: rdsCaBundleForRegion(ctx.region),
      REGISTRY_OIDC_ISSUER: "https://accounts.google.com",
      REGISTRY_OIDC_PROVIDER: "google",
      REGISTRY_REGISTRATION: "allowlist",
      REGISTRY_OPERATOR_DOMAIN: ctx.domainName,
      REGISTRY_CONTACT_EMAIL: ctx.contactEmail,
      REGISTRY_OIDC_CLIENT_ID: ctx.googleClientId,
      VIBTRA_REGISTRY_DATA_DIR: "/data",
      HOST: "0.0.0.0",
      PORT: "4700",
      VIBTRA_GUARD_CONSOLE_DIST: "/app/apps/guard-console/dist",
      VIBTRA_LANDING_DIST: "/app/apps/landing/dist",
      DB_HOST: db.dbInstanceEndpointAddress,
      DB_PORT: db.dbInstanceEndpointPort,
      DB_NAME: "vibtra_registry",
    };

    const secrets: Record<string, ecs.Secret> = {
      REGISTRY_SESSION_SECRET: ecs.Secret.fromSecretsManager(sessionSecret),
      REGISTRY_GATE_SIGNING_SECRET: ecs.Secret.fromSecretsManager(gateSigningSecret),
      VIBTRA_VAULT_KEY: ecs.Secret.fromSecretsManager(vaultKey),
      DB_USER: ecs.Secret.fromSecretsManager(dbSecret, "username"),
      DB_PASSWORD: ecs.Secret.fromSecretsManager(dbSecret, "password"),
      ...(previousVaultKey === undefined
        ? {}
        : { VIBTRA_VAULT_KEY_PREVIOUS: ecs.Secret.fromSecretsManager(previousVaultKey) }),
      ...(googleClientSecret === undefined
        ? {}
        : { REGISTRY_OIDC_CLIENT_SECRET: ecs.Secret.fromSecretsManager(googleClientSecret) }),
    };

    const service = new ecsPatterns.ApplicationLoadBalancedFargateService(this, "Service", {
      cluster,
      cpu: ctx.cpu,
      memoryLimitMiB: ctx.memoryLimitMiB,
      desiredCount: ctx.desiredCount,
      publicLoadBalancer: true,
      openListener: false,
      protocol: elbv2.ApplicationProtocol.HTTPS,
      certificate,
      redirectHTTP: false,
      sslPolicy: elbv2.SslPolicy.RECOMMENDED_TLS,
      idleTimeout: ALB_IDLE_TIMEOUT,
      taskSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
      assignPublicIp: false,
      circuitBreaker: { rollback: true },
      minHealthyPercent: 100,
      maxHealthyPercent: 200,
      healthCheckGracePeriod: Duration.seconds(90),
      enableExecuteCommand: ctx.enableExecuteCommand,
      runtimePlatform: TASK_RUNTIME_PLATFORM,
      taskImageOptions: {
        image: ecs.ContainerImage.fromEcrRepository(repository, ctx.imageTag),
        containerName: "registry",
        containerPort: 4700,
        entryPoint: REGISTRY_ENTRY_POINT,
        command: REGISTRY_CMD,
        environment,
        secrets,
        logDriver: ecs.LogDrivers.awsLogs({ streamPrefix: "registry", logGroup }),
      },
    });

    service.targetGroup.configureHealthCheck({
      path: "/api/auth/ok",
      healthyHttpCodes: "200",
      interval: Duration.seconds(30),
      timeout: Duration.seconds(5),
      healthyThresholdCount: 2,
      unhealthyThresholdCount: 3,
    });
    service.targetGroup.setAttribute("deregistration_delay.timeout_seconds", "30");
    service.loadBalancer.setAttribute("routing.http.drop_invalid_header_fields.enabled", "true");
    service.loadBalancer.setAttribute("routing.http.desync_mitigation_mode", "strictest");

    const prefixListLookupLogs = new logs.LogGroup(this, "PrefixListLookupLogs", {
      retention: logs.RetentionDays.ONE_MONTH,
      removalPolicy: RemovalPolicy.DESTROY,
    });
    const prefixListLookup = new cr.AwsCustomResource(this, "CloudFrontOriginFacingPrefixList", {
      resourceType: "Custom::VibtraCloudFrontPrefixList",
      onUpdate: {
        service: "EC2",
        action: "DescribeManagedPrefixLists",
        parameters: { Filters: [{ Name: "prefix-list-name", Values: [CLOUDFRONT_ORIGIN_FACING_PREFIX_LIST] }] },
        physicalResourceId: cr.PhysicalResourceId.of(CLOUDFRONT_ORIGIN_FACING_PREFIX_LIST),
        outputPaths: ["PrefixLists.0.PrefixListId"],
      },
      policy: cr.AwsCustomResourcePolicy.fromStatements([
        new iam.PolicyStatement({ actions: ["ec2:DescribeManagedPrefixLists"], resources: ["*"] }),
      ]),
      installLatestAwsSdk: false,
      logGroup: prefixListLookupLogs,
      timeout: Duration.seconds(30),
    });
    const cloudFrontPrefixListId = prefixListLookup.getResponseField("PrefixLists.0.PrefixListId");

    service.loadBalancer.connections.allowFrom(
      ec2.Peer.prefixList(cloudFrontPrefixListId),
      ec2.Port.tcp(443),
      "cloudfront origin-facing servers to alb :443 (the managed prefix list; the only inbound rule this group may carry)",
    );

    const albOrigin = new origins.LoadBalancerV2Origin(service.loadBalancer, {
      protocolPolicy: cloudfront.OriginProtocolPolicy.HTTPS_ONLY,
      originSslProtocols: [cloudfront.OriginSslPolicy.TLS_V1_2],
      readTimeout: EDGE_ORIGIN_TIMEOUT,
      keepaliveTimeout: EDGE_ORIGIN_TIMEOUT,
    });

    const wwwRedirect = new cloudfront.Function(this, "WwwRedirect", {
      runtime: cloudfront.FunctionRuntime.JS_2_0,
      comment: `301 ${wwwHost} to ${ctx.domainName} (host-34)`,
      code: cloudfront.FunctionCode.fromInline(wwwRedirectFunctionCode(ctx.domainName, wwwHost)),
    });
    const wwwRedirectAssociation: cloudfront.FunctionAssociation[] = [
      { function: wwwRedirect, eventType: cloudfront.FunctionEventType.VIEWER_REQUEST },
    ];

    const staticBehaviour: cloudfront.BehaviorOptions = {
      origin: albOrigin,
      allowedMethods: cloudfront.AllowedMethods.ALLOW_GET_HEAD,
      cachedMethods: cloudfront.CachedMethods.CACHE_GET_HEAD,
      compress: true,
      cachePolicy: cloudfront.CachePolicy.CACHING_OPTIMIZED,
      originRequestPolicy: cloudfront.OriginRequestPolicy.ALL_VIEWER,
      viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
      functionAssociations: wwwRedirectAssociation,
    };

    const distribution = new cloudfront.Distribution(this, "Edge", {
      comment: `vibtra registry edge for ${ctx.domainName} (host-31)`,
      domainNames: [ctx.domainName, wwwHost],
      certificate: edgeCertificate,
      minimumProtocolVersion: cloudfront.SecurityPolicyProtocol.TLS_V1_2_2021,
      sslSupportMethod: cloudfront.SSLMethod.SNI,
      httpVersion: cloudfront.HttpVersion.HTTP2_AND_3,
      priceClass: cloudfront.PriceClass.PRICE_CLASS_ALL,
      defaultBehavior: {
        origin: albOrigin,
        allowedMethods: cloudfront.AllowedMethods.ALLOW_ALL,
        cachePolicy: cloudfront.CachePolicy.CACHING_DISABLED,
        originRequestPolicy: cloudfront.OriginRequestPolicy.ALL_VIEWER,
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        compress: false,
        functionAssociations: wwwRedirectAssociation,
      },
      additionalBehaviors: {
        "/landing/*": staticBehaviour,
        "/assets/*": staticBehaviour,
      },
      errorResponses: [400, 403, 404, 405, 414, 416, 500, 501, 502, 503, 504].map((httpStatus) => ({
        httpStatus,
        ttl: Duration.seconds(0),
      })),
    });

    if (hostedZone !== undefined) {
      const target = route53.RecordTarget.fromAlias(new route53Targets.CloudFrontTarget(distribution));
      new route53.ARecord(this, "EdgeAliasA", { zone: hostedZone, recordName: ctx.domainName, target });
      new route53.AaaaRecord(this, "EdgeAliasAAAA", { zone: hostedZone, recordName: ctx.domainName, target });
      new route53.ARecord(this, "WwwAliasA", { zone: hostedZone, recordName: wwwHost, target });
      new route53.AaaaRecord(this, "WwwAliasAAAA", { zone: hostedZone, recordName: wwwHost, target });
    }

    db.connections.allowDefaultPortFrom(service.service, "registry tasks to postgres");

    const scaling = service.service.autoScaleTaskCount({
      minCapacity: ctx.desiredCount,
      maxCapacity: Math.max(ctx.maxCapacity, ctx.desiredCount),
    });
    if (ctx.maxCapacity > ctx.desiredCount) {
      scaling.scaleOnCpuUtilization("CpuScaling", {
        targetUtilizationPercent: 60,
        scaleInCooldown: Duration.minutes(5),
        scaleOutCooldown: Duration.minutes(1),
      });
    }

    const resealTask = new ecs.FargateTaskDefinition(this, "ResealTask", {
      cpu: 512,
      memoryLimitMiB: 1024,
      runtimePlatform: TASK_RUNTIME_PLATFORM,
    });
    resealTask.addContainer("reseal", {
      image: ecs.ContainerImage.fromEcrRepository(repository, ctx.imageTag),
      entryPoint: REGISTRY_ENTRY_POINT,
      command: [...REGISTRY_CMD, "reseal"],
      environment,
      secrets,
      logging: ecs.LogDrivers.awsLogs({ streamPrefix: "reseal", logGroup }),
    });

    new CfnOutput(this, "RegistryUrl", { value: `https://${ctx.domainName}` });
    new CfnOutput(this, "GoogleRedirectUri", {
      value: `https://${ctx.domainName}/api/auth/callback/google`,
      description: "Paste this into the Google OAuth client's Authorised redirect URIs. Nothing else works.",
    });
    new CfnOutput(this, "LoadBalancerDns", {
      value: service.loadBalancer.loadBalancerDnsName,
      description:
        "CloudFront's ORIGIN, not a public address: its security group admits only CloudFront's origin-facing " +
        "prefix list on 443, so a browser pointed here is refused. Point DNS at EdgeDistributionDomainName instead.",
    });
    new CfnOutput(this, "EdgeDistributionId", {
      value: distribution.distributionId,
      description: "aws cloudfront create-invalidation --distribution-id <this> --paths '/landing/og.png' '/landing/hero/*' — rarely needed (og.png and the hero's console renders are the unhashed files a day's edge cache can hold past a deploy); hashed files never are.",
    });
    new CfnOutput(this, "EdgeDistributionDomainName", {
      value: distribution.distributionDomainName,
      description: `What ${ctx.domainName} resolves to. With a hosted zone the stack writes the A and AAAA aliases; without one, alias the apex to this by hand.`,
    });
    new CfnOutput(this, "VaultKeySecretArn", {
      value: vaultKey.secretArn,
      description: "BACK THIS UP. Every stored credential is sealed under it.",
    });
    new CfnOutput(this, "SessionSecretArn", {
      value: sessionSecret.secretArn,
      description:
        "Console sessions only (DECISIONS.md host-9). Rotating it signs everyone out of the console and nothing " +
        "else — docs/deploy-registry-aws.md §1.5.",
    });
    new CfnOutput(this, "GateSigningSecretArn", {
      value: gateSigningSecret.secretArn,
      description:
        "BACK THIS UP. The tool-gate signing key in `jwks` is encrypted under it, so losing it means every " +
        "deployed tool's sign-in waits for a fresh key — docs/deploy-registry-aws.md §1.5.",
    });
    new CfnOutput(this, "DatabaseSecretArn", { value: dbSecret.secretArn });
    new CfnOutput(this, "LogGroupName", { value: logGroup.logGroupName });
    new CfnOutput(this, "ResealTaskDefinitionArn", {
      value: resealTask.taskDefinitionArn,
      description: "aws ecs run-task --cluster <cluster> --task-definition <this> --launch-type FARGATE …",
    });
    new CfnOutput(this, "ResealSecurityGroupId", {
      value: Fn.join(",", service.service.connections.securityGroups.map((g) => g.securityGroupId)),
      description:
        "run-task --network-configuration awsvpcConfiguration={securityGroups=[<this>]}. It is the SERVICE's own " +
        "group, and the only one the database admits.",
    });
    new CfnOutput(this, "ResealSubnetIds", {
      value: Fn.join(",", vpc.selectSubnets({ subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS }).subnetIds),
      description: "run-task --network-configuration awsvpcConfiguration={subnets=[<these>]} (no assignPublicIp).",
    });
    new CfnOutput(this, "ClusterName", { value: cluster.clusterName });

    new CfnOutput(this, "ManagedConnectionEgressIp", {
      value: managedConnectionEgress.attrPublicIp,
      description:
        "The single public IPv4 address every outbound connection from this control plane leaves through — the " +
        "address a customer allowlists in front of their own database. Fixed and RETAINed on purpose; it does not " +
        "change with a deploy. docs/deploy-registry-aws.md §8.",
    });
  }
}

const logRetention = (days: number): logs.RetentionDays => {
  const supported = Object.values(logs.RetentionDays).filter((v): v is number => typeof v === "number");
  const chosen = supported.sort((a, b) => a - b).find((v) => v >= days);
  return (chosen ?? logs.RetentionDays.TEN_YEARS) as logs.RetentionDays;
};
