import { mockProducerObserver } from '~/tests/helpers/mocks/producer.mock'

import { createCdpConsumerDeps } from '~/tests/helpers/cdp'
import { getFirstTeam, resetTestDatabase } from '~/tests/helpers/sql'

import { Hub, Team } from '../../types'
import { closeHub, createHub } from '../../utils/db/hub'
import { createHogExecutionGlobals } from '../_tests/fixtures'
import { CyclotronJobInvocation, CyclotronJobInvocationHogFunction } from '../types'
import { CdpCyclotronWorkerEmail } from './cdp-cyclotron-worker-email.consumer'

jest.setTimeout(5000)

describe('CdpCyclotronWorkerEmail', () => {
    let hub: Hub
    let team: Team
    let emailWorker: CdpCyclotronWorkerEmail

    beforeEach(async () => {
        await resetTestDatabase()
        hub = await createHub()
        team = await getFirstTeam(hub.postgres)
        emailWorker = new CdpCyclotronWorkerEmail(hub, createCdpConsumerDeps(hub))
    })

    afterEach(async () => {
        jest.setTimeout(10000)
        await closeHub(hub)
    })

    const createEmailInvocation = (overrides: Partial<CyclotronJobInvocation> = {}): CyclotronJobInvocation => ({
        id: 'email-invocation-1',
        teamId: team.id,
        functionId: 'function-1',
        queue: 'email',
        queuePriority: 0,
        queueParameters: {
            type: 'email',
            to: { email: 'user@example.com', name: 'Test User' },
            from: { email: 'noreply@posthog.com', name: 'PostHog', integrationId: 1 },
            subject: 'Test Email',
            text: 'Hello',
            html: '<p>Hello</p>',
        },
        state: {
            globals: createHogExecutionGlobals({}),
            vmState: null,
            timings: [],
            attempts: 0,
        },
        ...overrides,
    })

    describe('processInvocations', () => {
        it('should reject non-email invocations', async () => {
            const invocation = createEmailInvocation({
                queueParameters: { type: 'fetch', url: 'https://example.com', method: 'GET' },
            })

            const results = await emailWorker.processInvocations([invocation])

            expect(results).toHaveLength(1)
            expect(results[0].finished).toBe(true)
            expect(results[0].error).toBe('Non-email job in email queue')
        })

        it('should reject invocations with no queueParameters', async () => {
            const invocation = createEmailInvocation({ queueParameters: undefined })

            const results = await emailWorker.processInvocations([invocation])

            expect(results).toHaveLength(1)
            expect(results[0].finished).toBe(true)
            expect(results[0].error).toBe('Non-email job in email queue')
        })

        it('should call emailService.executeSendEmail for email invocations', async () => {
            const invocation = createEmailInvocation()
            const mockResult = {
                invocation: invocation as CyclotronJobInvocationHogFunction,
                finished: true,
                logs: [],
                metrics: [],
                capturedPostHogEvents: [],
                warehouseWebhookPayloads: [],
            }

            jest.spyOn(emailWorker['emailService'], 'executeSendEmail').mockResolvedValue(mockResult)

            const results = await emailWorker.processInvocations([invocation])

            expect(emailWorker['emailService'].executeSendEmail).toHaveBeenCalledWith(invocation)
            expect(results).toHaveLength(1)
            expect(results[0].finished).toBe(true)
            expect(results[0].error).toBeUndefined()
        })

        it('should retry transient errors with backoff', async () => {
            const invocation = createEmailInvocation()

            jest.spyOn(emailWorker['emailService'], 'executeSendEmail').mockRejectedValue(
                new Error('SES connection failed')
            )

            const results = await emailWorker.processInvocations([invocation])

            expect(results).toHaveLength(1)
            expect(results[0].finished).toBe(false)
            expect(results[0].error).toBeUndefined()
            expect(results[0].invocation.queueMetadata?.emailAttempts).toBe(1)
            expect(results[0].invocation.queueScheduledAt).toBeDefined()
        })

        it('should fail permanently after max retries', async () => {
            const invocation = createEmailInvocation({
                queueMetadata: { emailAttempts: 2 },
            })

            jest.spyOn(emailWorker['emailService'], 'executeSendEmail').mockRejectedValue(
                new Error('SES connection failed')
            )

            const results = await emailWorker.processInvocations([invocation])

            expect(results).toHaveLength(1)
            expect(results[0].finished).toBe(true)
            expect(results[0].error).toBe('Error: SES connection failed')
        })

        it('should not retry permanent errors', async () => {
            const invocation = createEmailInvocation()

            jest.spyOn(emailWorker['emailService'], 'executeSendEmail').mockRejectedValue(
                new Error('Email integration not found')
            )

            const results = await emailWorker.processInvocations([invocation])

            expect(results).toHaveLength(1)
            expect(results[0].finished).toBe(true)
            expect(results[0].error).toBe('Error: Email integration not found')
        })

        it('should handle errors returned in result (not thrown)', async () => {
            const invocation = createEmailInvocation()
            const mockResult = {
                invocation: invocation as CyclotronJobInvocationHogFunction,
                finished: true,
                error: 'Failed to send email via SES: throttling',
                logs: [],
                metrics: [],
                capturedPostHogEvents: [],
                warehouseWebhookPayloads: [],
            }

            jest.spyOn(emailWorker['emailService'], 'executeSendEmail').mockResolvedValue(mockResult)

            const results = await emailWorker.processInvocations([invocation])

            expect(results).toHaveLength(1)
            expect(results[0].finished).toBe(false)
            expect(results[0].invocation.queueMetadata?.emailAttempts).toBe(1)
        })

        it('should increase backoff with each retry', async () => {
            jest.spyOn(emailWorker['emailService'], 'executeSendEmail').mockRejectedValue(new Error('SES timeout'))

            const attempt1 = createEmailInvocation({ queueMetadata: {} })
            const results1 = await emailWorker.processInvocations([attempt1])
            const scheduledAt1 = results1[0].invocation.queueScheduledAt!

            const attempt2 = createEmailInvocation({ queueMetadata: { emailAttempts: 1 } })
            const results2 = await emailWorker.processInvocations([attempt2])
            const scheduledAt2 = results2[0].invocation.queueScheduledAt!

            // Second retry should be scheduled further out than the first
            expect(scheduledAt2.toMillis()).toBeGreaterThan(scheduledAt1.toMillis())
        })

        it('should process multiple invocations independently', async () => {
            const email1 = createEmailInvocation({ id: 'email-1' })
            const email2 = createEmailInvocation({ id: 'email-2' })
            const nonEmail = createEmailInvocation({
                id: 'non-email',
                queueParameters: { type: 'fetch', url: 'https://example.com', method: 'GET' },
            })

            const mockResult = (inv: CyclotronJobInvocation) => ({
                invocation: inv as CyclotronJobInvocationHogFunction,
                finished: true,
                logs: [],
                metrics: [],
                capturedPostHogEvents: [],
                warehouseWebhookPayloads: [],
            })

            jest.spyOn(emailWorker['emailService'], 'executeSendEmail')
                .mockResolvedValueOnce(mockResult(email1))
                .mockResolvedValueOnce(mockResult(email2))

            const results = await emailWorker.processInvocations([email1, nonEmail, email2])

            expect(results).toHaveLength(3)
            expect(results[0].finished).toBe(true)
            expect(results[0].error).toBeUndefined()
            expect(results[1].finished).toBe(true)
            expect(results[1].error).toBe('Non-email job in email queue')
            expect(results[2].finished).toBe(true)
            expect(results[2].error).toBeUndefined()

            expect(emailWorker['emailService'].executeSendEmail).toHaveBeenCalledTimes(2)
        })
    })

    describe('processBatch', () => {
        beforeEach(async () => {
            await emailWorker.start()

            jest.spyOn(emailWorker['cyclotronJobQueue']!, 'queueInvocationResults').mockImplementation(() =>
                Promise.resolve()
            )
            jest.spyOn(emailWorker['cyclotronJobQueue']!, 'queueInvocations').mockImplementation(() =>
                Promise.resolve()
            )
        })

        afterEach(async () => {
            await emailWorker.stop()
        })

        it('should process batch and queue results with monitoring metrics', async () => {
            const invocation = createEmailInvocation()
            const mockResult = {
                invocation: invocation as CyclotronJobInvocationHogFunction,
                finished: true,
                logs: [],
                metrics: [
                    {
                        team_id: team.id,
                        app_source_id: 'function-1',
                        instance_id: 'invocation-1',
                        metric_kind: 'email' as const,
                        metric_name: 'email_sent' as const,
                        count: 1,
                    },
                ],
                capturedPostHogEvents: [],
                warehouseWebhookPayloads: [],
            }

            jest.spyOn(emailWorker['emailService'], 'executeSendEmail').mockResolvedValue(mockResult)

            const { backgroundTask } = await emailWorker.processBatch([invocation])
            await backgroundTask

            expect(emailWorker['cyclotronJobQueue']!.queueInvocationResults).toHaveBeenCalledWith(
                expect.arrayContaining([
                    expect.objectContaining({
                        finished: true,
                    }),
                ])
            )

            // Verify monitoring metrics were produced to Kafka
            const producedMessages = mockProducerObserver.getProducedKafkaMessages()
            const appMetricMessages = producedMessages.filter((m) => m.topic.includes('app_metrics'))
            expect(appMetricMessages.length).toBeGreaterThan(0)
        })

        it('should queue retried email results as rescheduled jobs', async () => {
            const invocation = createEmailInvocation()

            jest.spyOn(emailWorker['emailService'], 'executeSendEmail').mockRejectedValue(new Error('SES throttling'))

            const { backgroundTask } = await emailWorker.processBatch([invocation])
            await backgroundTask

            // Should have called queueInvocationResults with a non-finished result (reschedule)
            expect(emailWorker['cyclotronJobQueue']!.queueInvocationResults).toHaveBeenCalledWith(
                expect.arrayContaining([
                    expect.objectContaining({
                        finished: false,
                        invocation: expect.objectContaining({
                            queueMetadata: expect.objectContaining({
                                emailAttempts: 1,
                            }),
                        }),
                    }),
                ])
            )
        })
    })
})
