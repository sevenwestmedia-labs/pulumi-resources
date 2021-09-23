import * as aws from '@pulumi/aws'
import * as pulumi from '@pulumi/pulumi'

export class Bucket extends pulumi.ComponentResource {
    readonly name: string
    readonly bucket: aws.s3.Bucket

    constructor(
        name: string,
        args: {
            website?: aws.s3.BucketArgs['website']
        },
        opts?: pulumi.ComponentResourceOptions,
    ) {
        super('swm:pulumi-static-site:bucket/Bucket', name, {}, opts)

        this.name = name

        this.bucket = new aws.s3.Bucket(
            name,
            {
                website: pulumi.output(args.website).apply((website) => ({
                    ...(website ?? {}),
                    indexDocument: website?.indexDocument ?? 'index.html',
                })),
            },
            { parent: this },
        )

        const accountNumber = aws
            .getCallerIdentity({ parent: this })
            .then((current) => current.accountId)

        const policy = pulumi
            .all([this.bucket.arn, accountNumber])
            .apply(([bucketArn, accountNumber]) =>
                aws.iam.getPolicyDocument(
                    {
                        version: '2012-10-17',
                        statements: [
                            {
                                sid: 'AllowPublicRead',
                                effect: 'Allow',
                                principals: [
                                    { type: 'AWS', identifiers: ['*'] },
                                ],
                                actions: ['s3:GetObject', 's3:ListBucket'],
                                resources: [`${bucketArn}/*`],
                            },
                            {
                                sid: 'AllowDevelopersToUpload',
                                effect: 'Allow',
                                principals: [
                                    {
                                        type: 'AWS',
                                        identifiers: [
                                            `arn:aws:iam::${accountNumber}:role/Wanews-ADFS-Digital-Developers`,
                                        ],
                                    },
                                ],
                                actions: [
                                    's3:GetObject',
                                    's3:PutObject',
                                    's3:DeleteObject',
                                    's3:AbortMultipartUpload',
                                ],
                                resources: [`${bucketArn}/*`],
                            },
                        ],
                    },
                    { parent: this },
                ),
            )

        new aws.s3.BucketPolicy(
            name,
            { bucket: this.bucket.id, policy: policy.json },
            { parent: this },
        )
    }

    async invalidateCloudfrontOnObjectChange(args: {
        distributionId: pulumi.Input<string>
        distributionArn: pulumi.Input<string>
    }) {
        pulumi
            .all([args.distributionId, args.distributionArn])
            .apply(([distributionId, distributionArn]) => {
                const cloudfrontInvalidationPolicy = new aws.iam.Policy(
                    `${this.name}-${distributionId}-policy-cloudfront-invalidation`,
                    {
                        policy: pulumi.output(
                            aws.iam.getPolicyDocument({
                                version: '2012-10-17',
                                statements: [
                                    {
                                        sid: 'AllowCloudFrontInvalidation',
                                        effect: 'Allow',
                                        actions: [
                                            'cloudfront:ListDistributions',
                                            'cloudfront:GetDistribution',
                                            'cloudfront:CreateInvalidation',
                                        ],
                                        resources: [distributionArn],
                                    },
                                ],
                            }),
                        ).json,
                    },
                )

                pulumi
                    .output(cloudfrontInvalidationPolicy.arn)
                    .apply((cloudfrontInvalidationPolicyArn) => {
                        const handler = new aws.lambda.CallbackFunction<
                            aws.s3.BucketEvent,
                            void
                        >(`${this.name}-${args.distributionId}-func`, {
                            policies: [
                                aws.iam.ManagedPolicy
                                    .AWSLambdaBasicExecutionRole,
                                cloudfrontInvalidationPolicyArn,
                            ],
                            callback: async (event) => {
                                const cloudfront = new aws.sdk.CloudFront()
                                const paths = (event.Records ?? []).map(
                                    (record) => record.s3.object.key,
                                )
                                await cloudfront
                                    .createInvalidation({
                                        DistributionId: distributionId,
                                        InvalidationBatch: {
                                            Paths: {
                                                Items: paths,
                                                Quantity: paths.length,
                                            },
                                            CallerReference: `${Date.now()}`,
                                        },
                                    })
                                    .promise()
                            },
                        })

                        this.bucket.onObjectCreated(
                            `${this.name}-${args.distributionId}-onObjectCreated`,
                            handler,
                            {},
                            { parent: this },
                        )

                        this.bucket.onObjectRemoved(
                            `${this.name}-${args.distributionId}-onObjectRemoved`,
                            handler,
                            {},
                            { parent: this },
                        )
                    })
            })
    }
}
