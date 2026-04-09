import api from 'lib/api'
import { LemonDialog } from 'lib/lemon-ui/LemonDialog'
import { LemonField } from 'lib/lemon-ui/LemonField'
import { LemonInput } from 'lib/lemon-ui/LemonInput'
import { lemonToast } from 'lib/lemon-ui/LemonToast/LemonToast'
import { Link } from 'lib/lemon-ui/Link'
import { autoCaptureEventToDescription } from 'lib/utils'
import { urls } from 'scenes/urls'

import { actionsModel } from '~/models/actionsModel'
import { ActionStepType, EventType, RecordingEventType } from '~/types'

import { applyDataAttributeSelector, applySubmitProperty, elementsToAction } from './createActionFromEvent'

type AutocaptureEvent = (EventType | RecordingEventType) & { event: '$autocapture' }

export function isAutocaptureWithElements(event: EventType | RecordingEventType): event is AutocaptureEvent {
    return event.event === '$autocapture' && event.elements?.length > 0
}

export function saveActionFromEvent(event: EventType | RecordingEventType, dataAttributes: string[]): void {
    const step: ActionStepType = {
        event: '$autocapture',
        url: event.properties.$current_url,
        url_matching: 'exact',
        ...elementsToAction(event.elements),
    }

    applyDataAttributeSelector(step, event.elements, dataAttributes)
    applySubmitProperty(step, event.properties)

    const suggestedName = autoCaptureEventToDescription(event)

    LemonDialog.openForm({
        title: 'Save as action',
        initialValues: { actionName: suggestedName },
        shouldAwaitSubmit: true,
        content: (
            <LemonField name="actionName" label="Action name">
                <LemonInput data-attr="save-as-action-name" placeholder="Action name" autoFocus />
            </LemonField>
        ),
        onSubmit: async ({ actionName }) => {
            try {
                const action = await api.actions.create({
                    name: actionName,
                    steps: [step],
                    _create_in_folder: 'Unfiled/Actions',
                })
                actionsModel.findMounted()?.actions.loadActions()
                lemonToast.success(
                    <>
                        Action created. <Link to={urls.action(action.id)}>View action</Link>
                    </>
                )
            } catch {
                lemonToast.error('Failed to create action. Please try again.')
            }
        },
    })
}
