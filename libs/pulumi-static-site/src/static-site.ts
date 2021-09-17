import * as aws from '@pulumi/aws'
import * as pulumi from '@pulumi/pulumi'

import { Bucket } from './bucket'
import { Distribution } from './cloudfront'

import { ValidateCertificate } from '@wanews/pulumi-certificate-validation'

export class StaticSite extends pulumi.ComponentResource {
    primaryBucket: aws.s3.Bucket
    primaryDistribution: aws.cloudfront.Distribution
    redirectBucket: aws.s3.Bucket
    redirectDistribution: aws.cloudfront.Distribution

    constructor(
        name: string,
        args: {
            acmCertificateArn?: pulumi.Input<string>
            primaryDomain: pulumi.Input<string>
            redirectDomains?: pulumi.Input<string>[] | pulumi.Input<string[]>
            originDomainName: pulumi.Input<string>
            priceClass?: pulumi.Input<string>
            cachePolicyId: pulumi.Input<string>
        },
        opts: pulumi.ComponentResourceOptions,
    ) {
        super('swm:pulumi-static-site:static-site/StaticSite', name, {}, opts)

        const cert = new aws.acm.Certificate(
            `${name}-cert`,
            {
                domainName: args.primaryDomain,
                subjectAlternativeNames: args.redirectDomains,
                validationMethod: 'DNS',
            },
            { parent: this },
        )

        const zones = pulumi
            .all([args.primaryDomain, args.redirectDomains])
            .apply(([primaryDomain, redirectDomains]) =>
                [...new Set([primaryDomain, ...redirectDomains])].map(
                    (domain) => ({
                        domain,
                        zoneId: pulumi.output(
                            aws.route53
                                .getZone({ name: domain }, { parent: this })
                                .catch((e) => {
                                    throw new pulumi.ResourceError(
                                        `unable to get zone id for domain ${domain}: ${e}`,
                                        this,
                                    )
                                }),
                        ).id,
                    }),
                ),
            )

        const acmCertificateArn = zones.apply(
            (zones) =>
                new ValidateCertificate(
                    `${name}-cert`,
                    {
                        cert,
                        zones,
                    },
                    { parent: this },
                ).validCertificateArn,
        )

        const primaryBucket = new Bucket(
            `${name}-primary`,
            {},
            { parent: this },
        )

        this.primaryBucket = primaryBucket.bucket

        this.primaryDistribution = new Distribution(
            `${name}-primary`,
            {
                acmCertificateArn,
                domains: [args.primaryDomain],
                originDomainName: this.primaryBucket.websiteEndpoint,
            },
            { parent: this },
        ).distribution

        primaryBucket.invalidateCloudfrontOnObjectChange({
            distributionId: this.primaryDistribution.id,
            distributionArn: this.primaryDistribution.arn,
        })

        const redirectBucket = new Bucket(
            `${name}-redirects`,
            {
                website: {
                    redirectAllRequestsTo: pulumi.interpolate`https://${args.primaryDomain}`,
                },
            },
            { parent: this },
        )

        this.redirectBucket = redirectBucket.bucket

        this.redirectDistribution = new Distribution(
            `${name}-redirects`,
            {
                acmCertificateArn,
                domains: pulumi
                    .output(args.redirectDomains)
                    .apply((redirectDomains) => [
                        ...new Set([...(redirectDomains ?? [])]),
                    ]),
                originDomainName: this.redirectBucket.websiteEndpoint,
            },
            { parent: this },
        ).distribution
    }
}
