import * as aws from '@pulumi/aws'
import * as pulumi from '@pulumi/pulumi'

export type S3BucketOptions = Partial<Omit<aws.s3.BucketArgs, 'tags'>> & {
    /**
     * A list of account numbers which need access to the bucket.
     * Example: ['11111111', '22222222', ...]
     *
     * Accounts in this list will be allowed to use IAM to grant access to
     * resources in this bucket.
     *
     * Note that any accounts NOT in this list will be unable to perform
     * s3:GetObject, even if they would be otherwise permitted by ACLs, UNLESS
     * the request includes a Referer header containing refererValue.
     *
     * Requires `alwaysDenyBadReferer: false`
     */
    permittedAccounts?: pulumi.Input<string[]>

    /**
     * If true, objects in the bucket will be owned by the bucket owner.
     *
     * If false, objects in the bucket will be owned by the object writer
     * (this is the default).
     */
    bucketOwnerPreferred?: pulumi.Input<boolean>

    /**
     * If true, deny requests with a bad Referer, even if they would otherwise
     * be permitted. Note that this will also affect you! So it may not be
     * desired. For backwards compatibility, is the default behaviour.
     *
     * If false, only deny requests with a bad Referer if they would not
     * otherwise be allowed. Required for permittedAccounts
     */
    alwaysDenyBadReferer?: pulumi.Input<boolean>

    /**
     * Allows extra statements to be added to the bucket policy. The default
     * policy will be merged with statements in this policy overriding those
     * with the same sid in the default policy. Overrides can be created
     * using `aws.iam.getPolicyDocument( ... ).then(doc => doc.json)`
     *
     * All instances of {{BUCKETARN}} will be replaced with the bucket arn.
     */
    bucketPolicyOverrides?: Promise<
        aws.iam.GetPolicyDocumentArgs['overridePolicyDocuments']
    >

    /**
     * If true, the bucket will be protected from deletion. Default: do not
     * protect the bucket.
     */
    protect?: boolean
}

export interface BucketArgs extends S3BucketOptions {
    /**
     * All s3:GetObject requests will be denied unless the request includes
     * a Referer header containing this value.
     *
     * This does not apply to accounts listed in permittedAccounts.
     */
    refererValue: pulumi.Input<string>

    /**
     * Allows an existing bucket to be imported into pulumi. The bucket will
     * then be managed by pulumi, and should not be modified elsewhere.
     */
    importBucket?: string | undefined

    /**
     * Allows you to override the bucket args; for use with importBucket to
     * allow importing the existing bucket without any changes.
     */
    overrideBucketArgs?: aws.s3.BucketArgs | undefined

    /**
     * Allows the bucket policy to be overridden. If possible, you should use
     * `extraBucketPolicyStatements` instead. However, this may be useful when
     * importing an existing bucket.
     */
    replaceBucketPolicy?: aws.s3.BucketArgs['policy'] | undefined

    getTags: (name: string) => {
        [key: string]: pulumi.Input<string>
    }
}

export class Bucket extends pulumi.ComponentResource {
    bucket: aws.s3.Bucket

    constructor(
        name: string,
        args: BucketArgs,
        opts?: pulumi.ComponentResourceOptions,
    ) {
        super('swm:pulumi-static-site:bucket/Bucket', name, {}, opts)

        const { refererValue, getTags, website, ...bucketOptions } = args

        pulumi
            .all([args.permittedAccounts, args.alwaysDenyBadReferer])
            .apply(([permittedAccounts, alwaysDenyBadReferer]) => {
                if (
                    (alwaysDenyBadReferer ?? true) &&
                    (permittedAccounts ?? []).length > 0
                ) {
                    pulumi.log.warn(
                        '`permittedAccounts` requires ' +
                            '`alwaysDenyBadReferer: false`, otherwise ' +
                            '`permittedAccounts` will not be able to get ' +
                            'objects unless the referer is also set in ' +
                            'the request headers. To suppress this ' +
                            'warning, set `alwaysDenyBadReferer: false` ' +
                            'in `bucketOptions`.',
                    )
                }
            })

        const bucketArgs = args.overrideBucketArgs ?? {
            ...bucketOptions,
            website: pulumi.output(website).apply((website) => ({
                indexDocument: 'index.html',
                ...website,
            })),
            tags: getTags(name),
        }
        this.bucket = new aws.s3.Bucket(name, bucketArgs, {
            parent: this,
            ...(args.importBucket ? { import: args.importBucket } : {}),
        })

        if (!args.importBucket) {
            const ownershipControls = new aws.s3.BucketOwnershipControls(
                name,
                {
                    bucket: this.bucket.id,
                    rule: {
                        objectOwnership: pulumi
                            .output(args.bucketOwnerPreferred)
                            .apply(
                                (bucketOwnerPreferred) =>
                                    bucketOwnerPreferred ?? false,
                            )
                            .apply((bucketOwnerPreferred) =>
                                bucketOwnerPreferred
                                    ? 'BucketOwnerPreferred'
                                    : 'ObjectWriter',
                            ),
                    },
                },
                {
                    parent: this,
                    protect: args.protect,
                },
            )

            const policy = pulumi
                .all([
                    this.bucket.arn,
                    refererValue,
                    args.permittedAccounts,
                    args.alwaysDenyBadReferer,
                    // This is not used, but hopefully fixes the error below.
                    //
                    // OperationAborted: A conflicting conditional operation is
                    // currently in progress against this resource. Please try
                    // again.
                    ownershipControls.id,
                    args.replaceBucketPolicy,
                ])
                .apply(
                    async ([
                        bucketArn,
                        refererValue,
                        permittedAccounts,
                        alwaysDenyBadReferer,
                        // eslint-disable-next-line @typescript-eslint/no-unused-vars
                        _ownershipId,
                        overrideBucketPolicy,
                    ]) => {
                        if (overrideBucketPolicy !== undefined) {
                            return overrideBucketPolicy
                        }

                        const basePolicy = await aws.iam
                            .getPolicyDocument({
                                version: '2012-10-17',
                                statements: [
                                    ...(alwaysDenyBadReferer ?? true
                                        ? [
                                              {
                                                  sid: 'AllowCloudFrontReadGetObject',
                                                  effect: 'Deny',
                                                  principals: [
                                                      {
                                                          type: '*',
                                                          identifiers: ['*'],
                                                      },
                                                  ],
                                                  actions: ['s3:GetObject'],
                                                  resources: [`${bucketArn}/*`],
                                                  conditions: [
                                                      {
                                                          test: 'StringNotEquals',
                                                          variable:
                                                              'aws:Referer',
                                                          values: [
                                                              refererValue,
                                                          ],
                                                      },
                                                  ],
                                              },
                                          ]
                                        : [
                                              {
                                                  sid: 'AllowCloudFrontReadGetObject',
                                                  effect: 'Allow',
                                                  principals: [
                                                      {
                                                          type: '*',
                                                          identifiers: ['*'],
                                                      },
                                                  ],
                                                  actions: ['s3:GetObject'],
                                                  resources: [`${bucketArn}/*`],
                                                  conditions: [
                                                      {
                                                          test: 'StringEquals',
                                                          variable:
                                                              'aws:Referer',
                                                          values: [
                                                              refererValue,
                                                          ],
                                                      },
                                                  ],
                                              },
                                          ]),
                                    ...((permittedAccounts ?? []).length > 0
                                        ? [
                                              {
                                                  sid: 'AllowIAMAccessToBucket',
                                                  effect: 'Allow',
                                                  principals: [
                                                      {
                                                          type: 'AWS',
                                                          identifiers:
                                                              permittedAccounts ??
                                                              [],
                                                      },
                                                  ],
                                                  actions: ['s3:*'],
                                                  resources: [`${bucketArn}/*`],
                                              },
                                              {
                                                  sid: 'AllowIAMAccessToListBucket',
                                                  effect: 'Allow',
                                                  principals: [
                                                      {
                                                          type: 'AWS',
                                                          identifiers:
                                                              permittedAccounts ??
                                                              [],
                                                      },
                                                  ],
                                                  actions: ['s3:ListBucket'],
                                                  resources: [bucketArn],
                                              },
                                          ]
                                        : []),
                                ],
                            })
                            .then((result) => result.json)

                        const bucketPolicyOverrides =
                            args.bucketPolicyOverrides ??
                            Promise.resolve(undefined)

                        return await bucketPolicyOverrides
                            ?.then((overrides) =>
                                overrides?.map((policy) =>
                                    policy.replace(/{{BUCKETARN}}/g, bucketArn),
                                ),
                            )
                            .then((overridePolicyDocuments) =>
                                aws.iam
                                    .getPolicyDocument(
                                        {
                                            version: '2012-10-17',
                                            sourcePolicyDocuments: [basePolicy],
                                            overridePolicyDocuments,
                                        },
                                        { parent: this },
                                    )
                                    .then((doc) => doc.json),
                            )
                    },
                )

            new aws.s3.BucketPolicy(
                name,
                { bucket: this.bucket.id, policy },
                { parent: this },
            )
        }
    }
}
