# pulumi-static-site

Provides an S3 bucket behind a CloudFront distribution for use as a static site.

Features:

- The bucket is private by default
- Automatic CloudFront cache invalidation

## Usage

```
import { StaticSite } from '@wanews/pulumi-static-site

new StaticSite('example.com', {
    primaryDomain: 'example.com',
    redirectDomains: [ 'www.example.com' ],
})
```

## Running unit tests

Run `nx test pulumi-static-site` to execute the unit tests via [Jest](https://jestjs.io).
