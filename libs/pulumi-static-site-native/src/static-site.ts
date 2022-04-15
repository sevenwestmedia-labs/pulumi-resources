import * as s3 from '@pulumi/aws-native/s3'
import * as route53 from '@pulumi/aws-native/route53'
import * as cloudfront from '@pulumi/aws-native/cloudfront'
import * as acm from '@pulumi/aws-native/acm'
import {Provider} from '@pulumi/aws-native/provider'
import * as pulumi from '@pulumi/pulumi'
import * as random from '@pulumi/random'

import { Bucket, S3BucketOptions } from './bucket'
import { CfDistributionOptions, StaticDistribution } from './cloudfront'

import { ValidateCertificate } from '@wanews/pulumi-certificate-validation'

interface StaticSiteArgs {
    primaryDomain: pulumi.Input<string>
    primaryHostname: pulumi.Input<string>
    getTags: (name: string) => {
        [key: string]: pulumi.Input<string>
    }
    distributionOptions?: CfDistributionOptions
    bucketOptions?: S3BucketOptions
}

export class StaticSite extends pulumi.ComponentResource {
    primaryBucket: s3.Bucket
    primaryDistribution: cloudfront.Distribution

    constructor(
        name: string,
        args: StaticSiteArgs,
        opts?: pulumi.ComponentResourceOptions & {
            distributionIgnoreChanges?: pulumi.ComponentResourceOptions['ignoreChanges']
            providerUsEast1?: pulumi.ProviderResource
            route53DnsARecordAliases?: pulumi.ComponentResourceOptions['aliases']
            route53DnsAAAARecordAliases?: pulumi.ComponentResourceOptions['aliases']
        },
    ) {
        super('swm:pulumi-static-site:static-site/StaticSite', name, {}, opts)

        const primaryDomainZone = pulumi
            .output(args.primaryDomain)
            .apply((domain) =>
                route53
                    .getZone({ name: domain }, { parent: this })
                    .catch((e) => {
                        throw new pulumi.ResourceError(
                            `unable to get zone id for domain ${domain}: ${e}`,
                            this,
                        )
                    }),
            )

        // Setup certificate for the domain
        const providerUsEast1 =
            opts?.providerUsEast1 ??
            new Provider(`${name}-aws-provider-us-east-1`, {
                region: 'us-east-1',
            })

        const cert = new acm.Certificate(
            `${name}-cert`,
            {
                domainName: args.primaryHostname,
                validationMethod: 'DNS',
            },
            { parent: this, provider: providerUsEast1 },
        )

        const validateCertificate = new ValidateCertificate(
            `${name}-cert`,
            {
                cert,
                zones: [
                    {
                        domain: args.primaryHostname,
                        zoneId: primaryDomainZone.id,
                    },
                ],
            },
            { parent: this, provider: providerUsEast1 },
        )

        // Generate referer secret
        const refererSecret = new random.RandomPassword(
            `${name}-referer-secret`,
            {
                length: 32,
                number: true,
                special: false,
            },
        )

        // Setup S3 Bucket
        const primaryBucket = new Bucket(
            `${name}-primary`,
            {
                ...args.bucketOptions,
                getTags: args.getTags,
                refererValue: refererSecret.result,
            },
            { parent: this },
        )
        this.primaryBucket = primaryBucket.bucket

        // Setup CF Distribution
        this.primaryDistribution = new StaticDistribution(
            `${name}-primary`,
            {
                ...args.distributionOptions,
                acmCertificateArn: validateCertificate.validCertificateArn,
                domains: [args.primaryHostname],
                originDomainName: this.primaryBucket.websiteEndpoint,
                refererValue: refererSecret.result,
                getTags: args.getTags,
            },
            {
                parent: this,
                distributionIgnoreChanges: opts?.distributionIgnoreChanges,
            },
        ).distribution

        // Add DNS records for the domain to point to the CF distribution
        new route53.Record(
            `${name}-primary-dns-A`,
            {
                name: args.primaryHostname,
                type: 'A',
                aliases: [
                    {
                        name: this.primaryDistribution.domainName,
                        zoneId: this.primaryDistribution.hostedZoneId,
                        evaluateTargetHealth: false,
                    },
                ],
                zoneId: primaryDomainZone.id,
            },
            { parent: this, aliases: opts?.route53DnsARecordAliases },
        )

        new route53.Record(
            `${name}-primary-dns-AAAA`,
            {
                name: args.primaryHostname,
                type: 'AAAA',
                aliases: [
                    {
                        name: this.primaryDistribution.domainName,
                        zoneId: this.primaryDistribution.hostedZoneId,
                        evaluateTargetHealth: false,
                    },
                ],
                zoneId: primaryDomainZone.id,
            },
            { parent: this, aliases: opts?.route53DnsAAAARecordAliases },
        )
    }
}
