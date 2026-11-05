# infra

The AWS CDK app (TypeScript) for the hosted Guard backend: CloudFront, an Application Load Balancer, ECS Fargate running the Guard server image (`apps/registry/Dockerfile`), Multi-AZ RDS PostgreSQL and Secrets Manager, in ap-southeast-2. Vibtra Cloud runs https://vibtra.app from it.

It was ported from the stack that served vibtra.app before Guard (VIB-22) with every construct ID, and therefore every CloudFormation logical ID, unchanged, so the move updated the existing stack in place.

## Stacks

| Stack | What |
|---|---|
| `VibtraRegistryEcr` | The image repository (`vibtra-registry`). Deployed once, before the first image. |
| `VibtraRegistryEdgeCertificate` | The CloudFront certificate in us-east-1. Only when no `edgeCertificateArn` is given. |
| `VibtraRegistry` | Everything else. |

## Configuration

Every setting is CDK context (`-c key=value`), parsed and checked in `lib/config.ts`. Account IDs, hosted zone IDs, certificate ARNs and secret ARNs are deploy-time context only. They are never written to a file in this repository: `cdk.context.json` and `cdk.out/` are gitignored.

## Checks

```sh
corepack pnpm@10.11.0 --filter @vibtra/infra typecheck
corepack pnpm@10.11.0 --filter @vibtra/guard-tests exec vitest run integration/infra/
```

The tests synthesise offline, with no account and no credentials.

- `tests/integration/infra/registry-stack.test.ts`, `edge.test.ts`, `openbao.test.ts`, `context.test.ts` and `guard-routes.test.ts`: the stack's security and runtime posture, and that the task runs what the Guard image (`apps/registry/Dockerfile`, `docker-entrypoint.sh`) and server actually read.
- `tests/integration/infra/logical-ids.test.ts`: every stateful resource (database, secrets, VPC and subnets, security groups, the egress address, the load balancer, CloudFront, DNS records, log groups, the ECR repository) keeps its deployed logical ID, type, replacement-forcing properties and deletion policy. The reference is `tests/integration/infra/fixtures/deployed-stateful.json`, captured from the previously deployed source with `scripts/stateful-snapshot.ts`. Regenerate it only for a deliberate change to a stateful resource, and say which and why in the pull request.

Vibtra Cloud's operator runbook and deploy workflow are kept in the private source repository and are not part of the public tree.
