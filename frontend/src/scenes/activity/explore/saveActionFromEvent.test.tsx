import '@testing-library/jest-dom'

import { cleanup, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

import { useMocks } from '~/mocks/jest'
import { initKeaTests } from '~/test/init'
import { EventType, RecordingEventType } from '~/types'

import { isAutocaptureWithElements, saveActionFromEvent } from './saveActionFromEvent'

function makeEvent(overrides: Partial<EventType> = {}): EventType {
    return {
        id: 'test-id',
        distinct_id: 'user-1',
        event: '$autocapture',
        timestamp: '2026-01-01T00:00:00Z',
        properties: { $current_url: 'https://example.com/page' },
        elements: [{ tag_name: 'button', text: 'Submit', attributes: {}, order: 0 }],
        ...overrides,
    } as EventType
}

describe('saveActionFromEvent', () => {
    afterEach(() => {
        cleanup()
        document.querySelectorAll('body > div:not(#root)').forEach((el) => el.remove())
    })

    beforeEach(() => {
        initKeaTests()
        useMocks({
            get: { '/api/projects/:team/actions/': { results: [] } },
            post: {
                '/api/projects/:team/actions/': () => [200, { id: 42, name: 'Test', steps: [] }],
            },
        })
    })

    describe('isAutocaptureWithElements', () => {
        it.each([
            ['autocapture with elements', makeEvent(), true],
            ['autocapture without elements', makeEvent({ elements: [] }), false],
            ['non-autocapture event', makeEvent({ event: '$pageview' }), false],
            [
                'recording event type with elements',
                { ...makeEvent(), fullyLoaded: true, playerTime: 0 } as RecordingEventType,
                true,
            ],
        ])('%s → %s', (_desc, event, expected) => {
            expect(isAutocaptureWithElements(event)).toBe(expected)
        })
    })

    describe('dialog interaction', () => {
        it('opens a dialog with pre-filled name and creates the action', async () => {
            let capturedBody: any = null
            useMocks({
                post: {
                    '/api/projects/:team/actions/': async (req) => {
                        capturedBody = await req.json()
                        return [200, { id: 42, name: capturedBody.name, steps: capturedBody.steps }]
                    },
                },
            })

            saveActionFromEvent(makeEvent(), [])

            await waitFor(() => {
                expect(screen.getByTestId('save-as-action-name')).toBeInTheDocument()
            })

            const submitButton = screen.getByRole('button', { name: 'Submit' })
            await userEvent.click(submitButton)

            await waitFor(() => {
                expect(capturedBody).not.toBeNull()
            })
            expect(capturedBody.steps).toHaveLength(1)
            expect(capturedBody.steps[0].event).toBe('$autocapture')
            expect(capturedBody.steps[0].text).toBe('Submit')
            expect(capturedBody.steps[0].url).toBe('https://example.com/page')
        })
    })
})
