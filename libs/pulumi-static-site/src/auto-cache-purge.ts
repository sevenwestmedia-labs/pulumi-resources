import fs from 'fs/promises'
import path from 'path'
import * as aws from '@pulumi/aws'
import * as pulumi from '@pulumi/pulumi'

export class AutoCachePurge extends pulumi.ComponentResource {
    function: aws.lambda.Function
    functionEventInvokeConfig: aws.lambda.FunctionEventInvokeConfig
    functionExecutionRole: aws.iam.Role
    functionResourcePolicy: aws.lambda.Permission
    bucketNotification: aws.s3.BucketNotification

    constructor(
        name: string,
        args: {
            bucket: aws.s3.Bucket | pulumi.Input<string>
            distribution: aws.cloudfront.Distribution | pulumi.Input<string>
            getTags: (name: string) => {
                [key: string]: pulumi.Input<string>
            }
        },
        opts?: pulumi.ComponentResourceOptions,
    ) {
        super(
            'swm:pulumi-static-site:auto-cache-purge/AutoCachePurge',
            name,
            {},
            opts,
        )

        const bucket = pulumi.output(args.bucket).apply(async (bucket) =>
            typeof bucket === 'string'
                ? await aws.s3
                      .getBucket({ bucket }, { parent: this })
                      .catch((e) => {
                          throw new pulumi.ResourceError(
                              `unable to find bucket ${bucket}: ${e}`,
                              this,
                          )
                      })
                : bucket,
        )

        const distribution = pulumi
            .output(args.distribution)
            .apply(async (distribution) =>
                typeof distribution === 'string'
                    ? await aws.cloudfront
                          .getDistribution(
                              { id: distribution },
                              { parent: this },
                          )
                          .catch((e) => {
                              throw new pulumi.ResourceError(
                                  `unable to find distribution with id ${distribution}: ${e}`,
                                  this,
                              )
                          })
                    : distribution,
            )

        this.functionExecutionRole = new aws.iam.Role(
            name,
            {
                assumeRolePolicy: aws.iam.assumeRolePolicyForPrincipal(
                    aws.iam.Principals.LambdaPrincipal,
                ),
                managedPolicyArns: [
                    aws.iam.ManagedPolicy.AWSLambdaBasicExecutionRole,
                ],
                inlinePolicies: [
                    {
                        name: 'allow-invalidate-cloudfront',
                        policy: aws.iam.getPolicyDocumentOutput(
                            {
                                version: '2012-10-17',
                                statements: [
                                    {
                                        actions: [
                                            'cloudfront:GetDistribution',
                                            'cloudfront:CreateInvalidation',
                                        ],
                                        resources: [distribution.arn],
                                    },
                                ],
                            },
                            { parent: this },
                        ).json,
                    },
                ],
                tags: args.getTags(name),
            },
            { parent: this },
        )

        const sourceFile = path.resolve(path.dirname(__filename), 'handler.mjs')
        const fileContents = fs.readFile(sourceFile, 'utf8').catch((err) => {
            throw new pulumi.ResourceError(
                `error reading ${sourceFile}: ${err}`,
                this,
            )
        })
        const handler = new pulumi.asset.StringAsset(fileContents)
        const code = new pulumi.asset.AssetArchive({ 'index.mjs': handler })

        this.function = new aws.lambda.Function(
            name,
            {
                code,
                handler: 'index.handler',
                description: pulumi.interpolate`automatically invalidates the cache on cloudfront distribution ${distribution.id} when objects are modified in bucket ${bucket.id}`,
                runtime: 'nodejs18.x',
                memorySize: 128,
                timeout: 60, // seconds
                environment: {
                    variables: {
                        BUCKET: bucket.id,
                        DISTRIBUTION: distribution.id,
                    },
                },
                role: this.functionExecutionRole.id,
                tags: args.getTags(name),
            },
            { parent: this },
        )

        this.functionResourcePolicy = new aws.lambda.Permission(
            name,
            {
                action: 'lambda:InvokeFunction',
                function: this.function,
                principal: 's3.amazonaws.com',
                sourceAccount: pulumi
                    .output(aws.getCallerIdentity({ parent: this }))
                    .apply((identity) => identity.accountId),
                sourceArn: bucket.arn,
            },
            { parent: this },
        )

        this.functionEventInvokeConfig =
            new aws.lambda.FunctionEventInvokeConfig(
                name,
                {
                    functionName: this.function.name,
                    maximumEventAgeInSeconds: 7200,
                    maximumRetryAttempts: 3,
                },
                { parent: this },
            )

        this.bucketNotification = new aws.s3.BucketNotification(
            name,
            {
                bucket: bucket.id,
                lambdaFunctions: [
                    {
                        lambdaFunctionArn: this.function.arn,
                        events: ['s3:ObjectCreated:*', 's3:ObjectRemoved:*'],
                    },
                ],
            },
            { parent: this },
        )
    }
}
