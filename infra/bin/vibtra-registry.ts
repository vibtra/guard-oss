#!/usr/bin/env tsx
import { App } from "aws-cdk-lib";
import { CLOUDFRONT_CERTIFICATE_REGION, readRegistryContext } from "../lib/config.js";
import { VibtraRegistryEcrStack } from "../lib/ecr-stack.js";
import { VibtraRegistryEdgeCertificateStack } from "../lib/edge-certificate-stack.js";
import { VibtraRegistryStack } from "../lib/registry-stack.js";

const app = new App();
const context = readRegistryContext(app.node);
const account = context.account === undefined ? {} : { account: context.account };
const env = { region: context.region, ...account };

new VibtraRegistryEcrStack(app, "VibtraRegistryEcr", {
  env,
  repositoryName: context.ecrRepositoryName,
  description: "Vibtra registry container image repository (ECR).",
});

const edgeCertificate =
  context.edgeCertificateArn === undefined
    ? new VibtraRegistryEdgeCertificateStack(app, "VibtraRegistryEdgeCertificate", {
        env: { region: CLOUDFRONT_CERTIFICATE_REGION, ...account },
        crossRegionReferences: true,
        context,
        description:
          `Vibtra registry edge certificate for ${context.domainName}: the CloudFront viewer certificate, in ` +
          `${CLOUDFRONT_CERTIFICATE_REGION} because CloudFront accepts no other region. Nothing else lives here.`,
      })
    : undefined;

new VibtraRegistryStack(app, "VibtraRegistry", {
  env,
  crossRegionReferences: true,
  context,
  ...(edgeCertificate === undefined ? {} : { edgeCertificate: edgeCertificate.certificate }),
  description:
    "Vibtra registry control plane: CloudFront + ALB + Fargate + RDS Postgres Multi-AZ + Secrets Manager, in " +
    `${context.region}. Customers' tools deploy to their own vendor accounts and are not described here.`,
});
