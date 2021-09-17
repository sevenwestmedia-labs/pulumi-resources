import * as aws from '@pulumi/aws'
import * as pulumi from '@pulumi/pulumi'
import * as random from '@pulumi/random'

export class Distribution extends pulumi.ComponentResource {
    distribution: aws.cloudfront.Distribution

    constructor(
        name: string,
        args: {
            acmCertificateArn?: pulumi.Input<string>
            domains: pulumi.Input<string>[] | pulumi.Input<string[]>
            originDomainName: pulumi.Input<string>
            priceClass?: pulumi.Input<string>
            cachePolicyId?: pulumi.Input<string>
            originRequestPolicyId?: pulumi.Input<string>
        },
        opts: pulumi.ComponentResourceOptions,
    ) {
        super(
            'swm:pulumi-static-site:distribution/Distribution',
            name,
            {},
            opts,
        )

        const originId = new random.RandomString(
            `${name}-originId`,
            {
                length: 8,
                special: false,
                number: false,
            },
            { parent: this },
        )

        const cachePolicyId = pulumi
            .all([
                args.cachePolicyId,
                pulumi.output(
                    aws.cloudfront.getCachePolicy(
                        {
                            name: 'Managed-CachingOptimized',
                        },
                        { parent: this },
                    ),
                ).id,
            ])
            .apply(
                ([cachePolicyId, defaultCachePolicyId]) =>
                    cachePolicyId ?? defaultCachePolicyId,
            )

        const originRequestPolicyId = pulumi
            .all([
                args.originRequestPolicyId,
                pulumi.output(
                    aws.cloudfront.getOriginRequestPolicy(
                        { name: 'Managed-CORS-S3Origin' },
                        { parent: this },
                    ),
                ).id,
            ])
            .apply(
                ([originRequestPolicyId, defaultOriginRequestPolicyId]) =>
                    originRequestPolicyId ?? defaultOriginRequestPolicyId,
            )

        this.distribution = new aws.cloudfront.Distribution(
            name,
            {
                enabled: true,
                isIpv6Enabled: true,
                aliases: args.domains,
                priceClass: args.priceClass ?? 'PriceClass_All',
                origins: [
                    {
                        originId: originId.result,
                        domainName: args.originDomainName,
                        customOriginConfig: {
                            originProtocolPolicy: 'http-only',
                            httpPort: 80,
                            httpsPort: 443,
                            originSslProtocols: ['TLSv1.2'],
                        },
                    },
                ],
                defaultRootObject: 'index.html',
                defaultCacheBehavior: {
                    targetOriginId: originId.result,
                    allowedMethods: ['GET', 'HEAD', 'OPTIONS'],
                    cachedMethods: ['GET', 'HEAD', 'OPTIONS'],
                    viewerProtocolPolicy: 'redirect-to-https',
                    ...(cachePolicyId ? { cachePolicyId } : {}),
                    ...(args.originRequestPolicyId
                        ? { originRequestPolicyId }
                        : {}),
                },
                restrictions: {
                    geoRestriction: {
                        restrictionType: 'none',
                    },
                },
                viewerCertificate: pulumi
                    .output(args.domains)
                    .apply((domains) =>
                        domains.length > 0
                            ? {
                                  acmCertificateArn: args.acmCertificateArn,
                                  minimumProtocolVersion: 'TLSv1.2_2019',
                                  sslSupportMethod: 'sni-only',
                              }
                            : {
                                  cloudfrontDefaultCertificate: true,
                                  minimumProtocolVersion: 'TLSv1',
                                  sslSupportMethod: 'sni-only',
                              },
                    ),
            },
            { parent: this },
        )
    }
}
