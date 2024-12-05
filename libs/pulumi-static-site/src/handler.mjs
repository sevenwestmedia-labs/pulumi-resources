import {
  CloudFrontClient,
  CreateInvalidationCommand,
} from '@aws-sdk/client-cloudfront'

const client = new CloudFrontClient()

export const handler = async (event, context) => {
  console.debug('EVENT: ' + JSON.stringify(event))

  if (!process.env.BUCKET) {
    throw new Error('environment variable BUCKET was not provided')
  }

  if (!process.env.DISTRIBUTION) {
    throw new Error('environment variable DISTRIBUTION was not provided')
  }

  try {
    const records = event.Records

    const items = []

    for (const record of records) {
      const bucket = record.s3.bucket.name
      const objectKey = record.s3.object.key

      if (bucket !== process.env.BUCKET) {
        console.warn(
          `ignoring event: bucket mismatch (expected ${process.env.BUCKET}, got ${bucket})`,
        )
        continue
      }

      items.push(objectKey)

      if (objectKey.split('/').pop() === 'index.html') {
        const parent = objectKey.replace(/index\.html$/, '')
        items.push(parent)
        items.push(parent.replace(/\/$/, ''))
      }
    }

    const deduplicatedItems = [
      ...new Set(
        items
          .filter((item) => !!item)
          .map((item) => item.replace(/^\//, ''))
          .map((item) => `/${item}`),
      ),
    ]

    const input = {
      DistributionId: `${process.env.DISTRIBUTION}`,
      InvalidationBatch: {
        Paths: {
          Quantity: Number(deduplicatedItems.length),
          Items: deduplicatedItems,
        },
      },
      CallerReference: `swm.auto-cache-invalidation.${process.env.BUCKET}.${process.env.DISTRIBUTION}.${context.awsRequestId}`,
    }

    const command = new CreateInvalidationCommand(input)
    const response = await client.send(command)

    console.debug(
      `cloudfront invalidation ${response.Invalidation?.Status}: ${response.Location}`,
    )
  } catch (e) {
    console.error(e)
    throw e
  }
}
