import * as aws from '@pulumi/aws'
import * as pulumi from '@pulumi/pulumi'
import * as random from '@pulumi/random'

// https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/using-managed-origin-request-policies.html
const managedCorsS3OriginRequestPolicyId =
    '88a5eaf4-2fd4-4709-b370-b4c650ea3fcf'

// https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/using-managed-cache-policies.html
const managedCachingOptimizedCachePolicyId =
    '658327ea-f89d-4fab-a63d-7e88639e58f6'

export interface CfDistributionOptions {
    priceClass?: pulumi.Input<string>
    httpVersion?: pulumi.Input<string>
    cachePolicyId?: pulumi.Input<string>
    originRequestPolicyId?: pulumi.Input<string>
    responseHeadersPolicyId?: pulumi.Input<string>
    webAclId?: pulumi.Input<string>
    lambdaFunctionAssociations?: pulumi.Input<
        pulumi.Input<aws.types.input.cloudfront.DistributionDefaultCacheBehaviorLambdaFunctionAssociation>[]
    >
    additionalOrigins?: pulumi.Input<
        pulumi.Input<aws.types.input.cloudfront.DistributionOrigin>[]
    >
    orderedCacheBehaviors?: pulumi.Input<
        pulumi.Input<aws.types.input.cloudfront.DistributionOrderedCacheBehavior>[]
    >
    protect?: boolean
    viewerProtocolPolicy?: pulumi.Input<string>
}

export interface DistributionArgs extends CfDistributionOptions {
    acmCertificateArn: pulumi.Input<string>
    domains: pulumi.Input<string>[] | pulumi.Input<string[]>
    originDomainName: pulumi.Input<string>
    refererValue: pulumi.Input<string>
    importDistribution?: string | undefined
    _overrideDistributionArgs?: aws.cloudfront.DistributionArgs | undefined
    getTags: (name: string) => {
        [key: string]: pulumi.Input<string>
    }
}

export class Distribution extends pulumi.ComponentResource {
    distribution: aws.cloudfront.Distribution

    constructor(
        name: string,
        args: DistributionArgs,
        opts?: pulumi.ComponentResourceOptions & {
            distributionIgnoreChanges?: pulumi.ComponentResourceOptions['ignoreChanges']
        },
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

        const distributionArgs: aws.cloudfront.DistributionArgs =
            args._overrideDistributionArgs
                ? args._overrideDistributionArgs
                : {
                      enabled: true,
                      isIpv6Enabled: true,
                      aliases: args.domains,
                      priceClass: args.priceClass ?? 'PriceClass_All',
                      origins: pulumi
                          .output(args.additionalOrigins)
                          .apply((origins) => [
                              {
                                  originId: originId.result,
                                  domainName: args.originDomainName,
                                  customOriginConfig: {
                                      originProtocolPolicy: 'http-only',
                                      httpPort: 80,
                                      httpsPort: 443,
                                      originSslProtocols: ['TLSv1.2'],
                                  },
                                  customHeaders: [
                                      {
                                          name: 'Referer',
                                          value: args.refererValue,
                                      },
                                  ],
                              },
                              ...(origins || []),
                          ]),
                      defaultRootObject: 'index.html',
                      defaultCacheBehavior: {
                          targetOriginId: originId.result,
                          allowedMethods: ['GET', 'HEAD', 'OPTIONS'],
                          cachedMethods: ['GET', 'HEAD', 'OPTIONS'],
                          viewerProtocolPolicy:
                              args.viewerProtocolPolicy ?? 'redirect-to-https',
                          cachePolicyId:
                              args.cachePolicyId ??
                              managedCachingOptimizedCachePolicyId,
                          originRequestPolicyId:
                              args.originRequestPolicyId ??
                              managedCorsS3OriginRequestPolicyId,
                          lambdaFunctionAssociations:
                              args.lambdaFunctionAssociations,
                          responseHeadersPolicyId: args.responseHeadersPolicyId,
                      },
                      orderedCacheBehaviors: args.orderedCacheBehaviors,
                      restrictions: {
                          geoRestriction: {
                              restrictionType: 'none',
                          },
                      },
                      viewerCertificate: {
                          acmCertificateArn: args.acmCertificateArn,
                          minimumProtocolVersion: 'TLSv1.2_2019',
                          sslSupportMethod: 'sni-only',
                      },
                      httpVersion: args.httpVersion ?? 'http2and3',
                      webAclId: args.webAclId,
                      comment: pulumi.interpolate`Static Site Distribution for ${pulumi
                          .output(args.domains)
                          .apply((domains) => domains.join(', '))}`,
                      tags: args.getTags(name),
                  }

        this.distribution = new aws.cloudfront.Distribution(
            name,
            distributionArgs,
            {
                protect: args.protect,
                parent: this,
                ignoreChanges: opts?.distributionIgnoreChanges,
                ...(args.importDistribution
                    ? { import: args.importDistribution }
                    : {}),
            },
        )
    }
}
