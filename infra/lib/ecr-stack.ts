import { Stack, type StackProps, RemovalPolicy, Duration, CfnOutput } from "aws-cdk-lib";
import * as ecr from "aws-cdk-lib/aws-ecr";
import type { Construct } from "constructs";

export interface VibtraRegistryEcrStackProps extends StackProps {
  readonly repositoryName: string;
}

export class VibtraRegistryEcrStack extends Stack {
  public readonly repository: ecr.Repository;

  public constructor(scope: Construct, id: string, props: VibtraRegistryEcrStackProps) {
    super(scope, id, props);

    this.repository = new ecr.Repository(this, "Repository", {
      repositoryName: props.repositoryName,
      imageScanOnPush: true,
      imageTagMutability: ecr.TagMutability.IMMUTABLE,
      encryption: ecr.RepositoryEncryption.AES_256,
      removalPolicy: RemovalPolicy.RETAIN,
      lifecycleRules: [
        {
          description: "Keep the last 30 tagged images; expire untagged layers after a week.",
          tagStatus: ecr.TagStatus.UNTAGGED,
          maxImageAge: Duration.days(7),
        },
        {
          description: "Keep the last 30 images of any tag.",
          tagStatus: ecr.TagStatus.ANY,
          maxImageCount: 30,
        },
      ],
    });

    new CfnOutput(this, "RepositoryUri", {
      value: this.repository.repositoryUri,
      description: "docker tag … <this> and push. The CI workflow reads it from this output.",
    });
    new CfnOutput(this, "RepositoryName", { value: this.repository.repositoryName });
  }
}
