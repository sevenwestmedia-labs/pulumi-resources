import * as pulumi from '@pulumi/pulumi'
import * as aws from '@pulumi/aws'

import { StaticSite } from '@wanews/pulumi-static-site'

new StaticSite('example.swmdigital.io', {
    primaryDomain: 'example.swmdigital.io',
    redirectDomains: ['www.example.swmdigital.io'],
})
