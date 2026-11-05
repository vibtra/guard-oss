import { CfnOutput, Stack, type StackProps, Tags } from "aws-cdk-lib";
import * as acm from "aws-cdk-lib/aws-certificatemanager";
import * as route53 from "aws-cdk-lib/aws-route53";
import type { Construct } from "constructs";
import { CLOUDFRONT_CERTIFICATE_REGION, type RegistryContext, wwwHostFor } from "./config.js";

export interface VibtraRegistryEdgeCertificateStackProps extends StackProps {
  readonly context: RegistryContext;
}

export class VibtraRegistryEdgeCertificateStack extends Stack {
  public readonly certificate: acm.Certificate;

  public constructor(scope: Construct, id: string, props: VibtraRegistryEdgeCertificateStackProps) {
    super(scope, id, props);
    const ctx = props.context;

    if (this.region !== CLOUDFRONT_CERTIFICATE_REGION) {
      throw new Error(
        `vibtra infra: ${id} must be deployed in ${CLOUDFRONT_CERTIFICATE_REGION} (it is in ${this.region}) — ` +
          "CloudFront reads its viewer certificate from that region and no other.",
      );
    }

    Tags.of(this).add("vibtra:component", "registry-edge-certificate");
    Tags.of(this).add("vibtra:residency", ctx.region);

    const hostedZone =
      ctx.hostedZoneId !== undefined && ctx.hostedZoneName !== undefined
        ? route53.HostedZone.fromHostedZoneAttributes(this, "Zone", {
            hostedZoneId: ctx.hostedZoneId,
            zoneName: ctx.hostedZoneName,
          })
        : undefined;

    this.certificate = new acm.Certificate(this, "Certificate", {
      domainName: ctx.domainName,
      subjectAlternativeNames: [wwwHostFor(ctx.domainName)],
      validation:
        hostedZone === undefined ? acm.CertificateValidation.fromDns() : acm.CertificateValidation.fromDns(hostedZone),
    });

    new CfnOutput(this, "EdgeCertificateArn", {
      value: this.certificate.certificateArn,
      description:
        `The CloudFront viewer certificate for ${ctx.domainName}, in ${CLOUDFRONT_CERTIFICATE_REGION}. ` +
        "Pass it as -c edgeCertificateArn=… to a stack that should import rather than own it.",
    });
  }
}
