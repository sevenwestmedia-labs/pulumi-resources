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
    records: pulumi.Output<aws.route53.Record[]>

    constructor(
        name: string,
        args: {
            primaryDomain: pulumi.Input<string>
            redirectDomains?: pulumi.Input<string>[] | pulumi.Input<string[]>
            priceClass?: pulumi.Input<string>
            cachePolicyId?: pulumi.Input<string>
            originRequestPolicyId?: pulumi.Input<string>
        },
        opts?: pulumi.ComponentResourceOptions,
    ) {
        super('swm:pulumi-static-site:static-site/StaticSite', name, {}, opts)

        const primaryDomain = args.primaryDomain
        const redirectDomains = pulumi
            .all([primaryDomain, args.redirectDomains])
            .apply(([primaryDomain, redirectDomains]) => {
                const uniqueRedirectDomains = new Set(redirectDomains ?? [])
                uniqueRedirectDomains.delete(primaryDomain)
                return [...uniqueRedirectDomains]
            })

        const cert = new aws.acm.Certificate(
            `${name}-cert`,
            {
                domainName: primaryDomain,
                subjectAlternativeNames: redirectDomains,
                validationMethod: 'DNS',
            },
            { parent: this },
        )

        const zones = pulumi
            .all([primaryDomain, redirectDomains])
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
                domains: [primaryDomain],
                originDomainName: this.primaryBucket.websiteEndpoint,
                priceClass: args.priceClass,
                cachePolicyId: args.cachePolicyId,
                originRequestPolicyId: args.originRequestPolicyId,
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
                    redirectAllRequestsTo: pulumi.interpolate`https://${primaryDomain}`,
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
                    .output(redirectDomains)
                    .apply((redirectDomains) => [
                        ...new Set([...(redirectDomains ?? [])]),
                    ]),
                originDomainName: this.redirectBucket.websiteEndpoint,
                priceClass: args.priceClass,
                cachePolicyId: args.cachePolicyId,
                originRequestPolicyId: args.originRequestPolicyId,
            },
            { parent: this },
        ).distribution

        const getZoneIdForDomain = (domain: pulumi.Input<string>, z = zones) =>
            pulumi.all([domain, z]).apply(
                ([domain, zones]) =>
                    zones.filter((x) => x.domain === domain).shift()?.zoneId ??
                    (() => {
                        throw new pulumi.ResourceError(
                            `zone id lookup failed for domain`,
                            this,
                        )
                    })(),
            )

        this.records = pulumi.output(redirectDomains).apply((redirectDomains) =>
            ['AAAA', 'A']
                .map((type) => [
                    new aws.route53.Record(
                        `${name}-${primaryDomain}-${type}`,
                        {
                            name: primaryDomain,
                            type,
                            zoneId: getZoneIdForDomain(primaryDomain),
                            aliases: [
                                {
                                    name: this.primaryDistribution.domainName,
                                    zoneId: this.primaryDistribution
                                        .hostedZoneId,
                                    evaluateTargetHealth: false,
                                },
                            ],
                        },
                        { parent: this },
                    ),
                    ...redirectDomains.map(
                        (redirectDomain) =>
                            new aws.route53.Record(
                                `${name}-${redirectDomain}-${type}`,
                                {
                                    name: redirectDomain,
                                    type,
                                    zoneId: getZoneIdForDomain(redirectDomain),
                                    aliases: [
                                        {
                                            name: this.redirectDistribution
                                                .domainName,
                                            zoneId: this.redirectDistribution
                                                .hostedZoneId,
                                            evaluateTargetHealth: false,
                                        },
                                    ],
                                },
                                { parent: this },
                            ),
                    ),
                ])
                .flat(),
        )
    }
}
