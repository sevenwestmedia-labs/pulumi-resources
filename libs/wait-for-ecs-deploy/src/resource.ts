import * as pulumi from '@pulumi/pulumi'
import { EcsWaiter, EcsWaiterProps } from './dynamic-resource'

export type WaitForEcsDeploymentArgs = EcsWaiterProps

export class WaitForEcsDeployment extends pulumi.ComponentResource {
    constructor(
        name: string,
        args: WaitForEcsDeploymentArgs,
        opts?: pulumi.ComponentResourceOptions,
    ) {
        super('swm:wait-for-ecs/WaitForEcsDeployment', name, {}, opts)

        const waiter = new EcsWaiter(name, args, opts)

        pulumi
            .all([waiter.status, waiter.failureMessage])
            .apply(([status, failureMessage]) => {
                if (status !== 'COMPLETED') {
                    throw new pulumi.ResourceError(
                        `ECS deployment failed: ${failureMessage}`,
                        this,
                    )
                }
            })
    }
}