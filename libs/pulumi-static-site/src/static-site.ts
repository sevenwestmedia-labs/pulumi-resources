import * as aws from '@pulumi/aws'
import * as pulumi from '@pulumi/pulumi'
import * as random from '@pulumi/random'

import { Bucket, S3BucketOptions } from './bucket'
import { CfDistributionOptions, Distribution } from './cloudfront'

import { ValidateCertificate } from '@wanews/pulumi-certificate-validation'
import { AutoCachePurge } from './auto-cache-purge'

export interface StaticSiteArgs {
    primaryDomain: pulumi.Input<string>
    primaryHostname: pulumi.Input<string>
    getTags: (name: string) => {
        [key: string]: pulumi.Input<string>
    }
    distributionOptions?: CfDistributionOptions
    bucketOptions?: S3BucketOptions
    importDistribution?: {
        distributionId: string
        overrideDistributionArgs?: aws.cloudfront.DistributionArgs | undefined
    }
    importPrimaryBucket?: {
        bucketId?: string | undefined
        skipPolicy?: boolean | undefined
        overrideBucketArgs?: aws.s3.BucketArgs | undefined
    }
    dnsOptions?: {
        skipDns?: boolean
        allowOverwrite?: boolean
    }
    automaticallyPurgeCdn?: boolean
}

export interface StaticSiteOptions extends pulumi.ComponentResourceOptions {
    distributionIgnoreChanges?: pulumi.ComponentResourceOptions['ignoreChanges']
    providerUsEast1?: pulumi.ProviderResource
    dnsProvider?: pulumi.ProviderResource
    route53DnsARecordAliases?: pulumi.ComponentResourceOptions['aliases']
    route53DnsAAAARecordAliases?: pulumi.ComponentResourceOptions['aliases']
}

export class StaticSite extends pulumi.ComponentResource {
    primaryBucket: aws.s3.Bucket
    primaryDistribution: aws.cloudfront.Distribution

    constructor(name: string, args: StaticSiteArgs, opts?: StaticSiteOptions) {
        super('swm:pulumi-static-site:static-site/StaticSite', name, {}, opts)

        // Setup certificate for the domain
        const providerUsEast1 =
            opts?.providerUsEast1 ??
            new aws.Provider(`${name}-aws-provider-us-east-1`, {
                region: 'us-east-1',
            })

        // Allow using a different provider for certificate validation and DNS
        // record creation
        const dnsProvider = opts?.dnsProvider ?? providerUsEast1

        const primaryDomainZone = pulumi
            .output(args.primaryDomain)
            .apply((domain) =>
                aws.route53
                    .getZone(
                        { name: domain },
                        { parent: this, provider: dnsProvider },
                    )
                    .catch((e) => {
                        throw new pulumi.ResourceError(
                            `unable to get zone id for domain ${domain}: ${e}`,
                            this,
                        )
                    }),
            )

        const cert = new aws.acm.Certificate(
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
                        provider: dnsProvider,
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
            {
                parent: this,
            },
        )

        // Setup S3 Bucket
        const primaryBucket = new Bucket(
            `${name}-primary`,
            {
                importBucket: args.importPrimaryBucket?.bucketId,
                overrideBucketArgs:
                    args.importPrimaryBucket?.overrideBucketArgs,
                ...args.bucketOptions,
                getTags: args.getTags,
                refererValue: refererSecret.result,
            },
            { parent: this },
        )
        this.primaryBucket = primaryBucket.bucket

        // Setup CF Distribution
        this.primaryDistribution = new Distribution(
            `${name}-primary`,
            {
                ...args.distributionOptions,
                acmCertificateArn: validateCertificate.validCertificateArn,
                domains: [args.primaryHostname],
                originDomainName: this.primaryBucket.websiteEndpoint,
                refererValue: refererSecret.result,
                importDistribution: args.importDistribution?.distributionId,
                _overrideDistributionArgs:
                    args.importDistribution?.overrideDistributionArgs,
                getTags: args.getTags,
            },
            {
                parent: this,
                distributionIgnoreChanges: opts?.distributionIgnoreChanges,
            },
        ).distribution

        if (!args.dnsOptions?.skipDns) {
            // Add DNS records for the domain to point to the CF distribution
            new aws.route53.Record(
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
                    allowOverwrite: args.dnsOptions?.allowOverwrite,
                },
                {
                    parent: this,
                    provider: dnsProvider,
                    aliases: opts?.route53DnsARecordAliases,
                },
            )

            new aws.route53.Record(
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
                    allowOverwrite: args.dnsOptions?.allowOverwrite,
                },
                {
                    parent: this,
                    provider: dnsProvider,
                    aliases: opts?.route53DnsAAAARecordAliases,
                },
            )
        }

        if (args.automaticallyPurgeCdn) {
            new AutoCachePurge(`${name}-auto-cache-purge`, {
                bucket: this.primaryBucket,
                distribution: this.primaryDistribution,
                getTags: args.getTags,
            })
        }
    }
}
