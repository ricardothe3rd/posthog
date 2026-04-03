import { DateTime } from 'luxon'
import { Counter } from 'prom-client'

import { instrumented } from '~/common/tracing/tracing-utils'
import { PluginsServerConfig } from '~/types'

import { logger } from '../../utils/logger'
import { CyclotronJobInvocation, CyclotronJobInvocationHogFunction, CyclotronJobInvocationResult } from '../types'
import { createInvocationResult } from '../utils/invocation-utils'
import { CdpConsumerBaseDeps } from './cdp-base.consumer'
import { CdpCyclotronWorker } from './cdp-cyclotron-worker.consumer'

const emailWorkerProcessed = new Counter({
    name: 'cdp_email_worker_processed_total',
    help: 'Total emails processed by the email worker',
    labelNames: ['status'],
})

const MAX_RETRIES = 3
const BACKOFF_BASE_MS = 5_000

// Errors that should not be retried — they won't succeed on a subsequent attempt
const PERMANENT_ERRORS = [
    'Email integration not found',
    'The selected email integration domain is not verified',
    'The selected email integration is not configured correctly',
    'Email delivery mode not supported',
    'Invocation passed to sendEmail is not an email function',
]

function isTransientError(error: string): boolean {
    return !PERMANENT_ERRORS.some((permanent) => error.includes(permanent))
}

export class CdpCyclotronWorkerEmail extends CdpCyclotronWorker {
    protected name = 'CdpCyclotronWorkerEmail'

    constructor(config: PluginsServerConfig, deps: CdpConsumerBaseDeps) {
        super(config, deps, 'email')
    }

    @instrumented('cdpConsumer.handleEachBatch.executeEmailInvocations')
    public async processInvocations(invocations: CyclotronJobInvocation[]): Promise<CyclotronJobInvocationResult[]> {
        const results: CyclotronJobInvocationResult[] = []

        for (const invocation of invocations) {
            try {
                if (invocation.queueParameters?.type !== 'email') {
                    logger.warn('Non-email job found in email queue', { id: invocation.id })
                    results.push(
                        createInvocationResult(
                            invocation,
                            {},
                            { finished: true, error: 'Non-email job in email queue' }
                        )
                    )
                    emailWorkerProcessed.inc({ status: 'invalid' })
                    continue
                }

                const result = await this.emailService.executeSendEmail(invocation as CyclotronJobInvocationHogFunction)

                if (result.error) {
                    results.push(this.handleError(invocation, result.error))
                } else {
                    results.push(result)
                    emailWorkerProcessed.inc({ status: 'sent' })
                }
            } catch (error) {
                results.push(this.handleError(invocation, String(error)))
            }
        }

        return results
    }

    private handleError(invocation: CyclotronJobInvocation, error: string): CyclotronJobInvocationResult {
        const attempts = (invocation.queueMetadata?.emailAttempts ?? 0) + 1
        const errorMessage = String(error)

        if (isTransientError(errorMessage) && attempts < MAX_RETRIES) {
            const delayMs = BACKOFF_BASE_MS * Math.pow(2, attempts - 1)
            logger.warn('Email send failed, scheduling retry', {
                id: invocation.id,
                teamId: invocation.teamId,
                attempt: attempts,
                maxRetries: MAX_RETRIES,
                nextRetryMs: delayMs,
                error: errorMessage,
            })
            emailWorkerProcessed.inc({ status: 'retried' })

            return createInvocationResult(
                invocation,
                {
                    queueScheduledAt: DateTime.now().plus({ milliseconds: delayMs }),
                    queueMetadata: {
                        ...invocation.queueMetadata,
                        emailAttempts: attempts,
                    },
                },
                { finished: false }
            )
        }

        logger.error('Email send failed permanently', {
            id: invocation.id,
            teamId: invocation.teamId,
            attempt: attempts,
            error: errorMessage,
            permanent: !isTransientError(errorMessage),
        })
        emailWorkerProcessed.inc({ status: 'error' })

        return createInvocationResult(invocation, {}, { finished: true, error: errorMessage })
    }
}
