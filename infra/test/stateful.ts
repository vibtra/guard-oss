export const STATEFUL_TYPES: Readonly<Record<string, "all" | readonly string[]>> = {
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

export const STATEFUL_TEST_CONTEXT: Readonly<Record<string, string>> = {
  imageTag: "guard-v0.0.0-test",
  domainName: "vibtra.app",
  hostedZoneId: "Z0000000000000EXAMPLE",
  hostedZoneName: "vibtra.app",
  googleClientId: "example.apps.googleusercontent.com",
  googleClientSecretArn: "arn:aws:secretsmanager:ap-southeast-2:123456789012:secret:example-google-client-AbCdEf",
  certificateArn: "arn:aws:acm:ap-southeast-2:123456789012:certificate/00000000-0000-4000-8000-000000000001",
  edgeCertificateArn: "arn:aws:acm:us-east-1:123456789012:certificate/00000000-0000-4000-8000-000000000002",
};

export interface StatefulEntry {
  type: string;
  properties: Record<string, unknown>;
  deletionPolicy?: string;
  updateReplacePolicy?: string;
}

interface CfnResource {
  Type: string;
  Properties?: Record<string, unknown>;
  DeletionPolicy?: string;
  UpdateReplacePolicy?: string;
}

export const statefulSnapshot = (template: { Resources?: Record<string, CfnResource> }): Record<string, StatefulEntry> => {
  const out: Record<string, StatefulEntry> = {};
  for (const [id, resource] of Object.entries(template.Resources ?? {}).sort(([a], [b]) => a.localeCompare(b))) {
    const pinned = STATEFUL_TYPES[resource.Type];
    if (pinned === undefined) continue;
    const all = resource.Properties ?? {};
    const properties =
      pinned === "all" ? all : Object.fromEntries(pinned.filter((k) => k in all).map((k) => [k, all[k]]));
    out[id] = {
      type: resource.Type,
      properties,
      ...(resource.DeletionPolicy === undefined ? {} : { deletionPolicy: resource.DeletionPolicy }),
      ...(resource.UpdateReplacePolicy === undefined ? {} : { updateReplacePolicy: resource.UpdateReplacePolicy }),
    };
  }
  return out;
};
