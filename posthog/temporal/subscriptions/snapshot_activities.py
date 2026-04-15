import datetime as dt

import temporalio.activity
from structlog import get_logger

from posthog.api.services.query import ExecutionMode
from posthog.caching.calculate_results import calculate_for_query_based_insight
from posthog.models.subscription import Subscription
from posthog.redis import get_async_client
from posthog.sync import database_sync_to_async
from posthog.temporal.subscriptions.change_summary_state import (
    compute_ttl_seconds,
    generate_state_key,
    load_insight_state,
    store_insight_state,
)
from posthog.temporal.subscriptions.llm_change_summary import generate_change_summary
from posthog.temporal.subscriptions.results_summarizer import build_results_summary
from posthog.temporal.subscriptions.types import InsightSnapshotState, SnapshotInsightsInputs, SnapshotInsightsResult

LOGGER = get_logger(__name__)


def _get_query_kind(query: dict | None) -> str:
    if not query:
        return "Unknown"
    source = query.get("source", query)
    return source.get("kind", "Unknown")


def _execute_insight_query(insight, team, dashboard=None):
    return calculate_for_query_based_insight(
        insight,
        team=team,
        dashboard=dashboard,
        execution_mode=ExecutionMode.RECENT_CACHE_CALCULATE_BLOCKING_IF_STALE,
        user=None,
    )


@temporalio.activity.defn
async def snapshot_subscription_insights(inputs: SnapshotInsightsInputs) -> SnapshotInsightsResult:
    await LOGGER.ainfo(
        "snapshot_subscription_insights.starting",
        subscription_id=inputs.subscription_id,
    )

    subscription = await database_sync_to_async(
        Subscription.objects.select_related("insight", "dashboard", "team").get,
        thread_sensitive=False,
    )(pk=inputs.subscription_id)

    team = subscription.team
    dashboard = subscription.dashboard

    if dashboard:
        tiles = await database_sync_to_async(
            lambda: list(
                dashboard.tiles.select_related("insight").filter(insight__isnull=False, insight__deleted=False).all()
            ),
            thread_sensitive=False,
        )()
        insights = [tile.insight for tile in tiles if tile.insight]

        selected_ids = await database_sync_to_async(
            lambda: (
                set(subscription.dashboard_export_insights.values_list("id", flat=True))
                if subscription.dashboard_export_insights.exists()
                else None
            ),
            thread_sensitive=False,
        )()
        if selected_ids:
            insights = [i for i in insights if i.id in selected_ids]
    elif subscription.insight:
        insights = [subscription.insight]
    else:
        await LOGGER.awarning(
            "snapshot_subscription_insights.no_insights",
            subscription_id=inputs.subscription_id,
        )
        return SnapshotInsightsResult()

    redis_client = get_async_client()
    ttl = compute_ttl_seconds(subscription.frequency, subscription.interval)
    now = dt.datetime.now(dt.UTC).isoformat()

    previous_states: list[InsightSnapshotState] = []
    current_state_dicts: list[dict] = []
    has_any_previous = False

    for insight in insights:
        key = generate_state_key(inputs.subscription_id, insight.id)

        previous = await load_insight_state(redis_client, key)
        if previous is not None:
            has_any_previous = True
            previous_states.append(
                InsightSnapshotState(
                    insight_id=insight.id,
                    insight_name=previous.get("insight_name", ""),
                    query_definition=previous.get("query_definition", {}),
                    results_summary=previous.get("results_summary", ""),
                    timestamp=previous.get("timestamp", ""),
                )
            )

        query_kind = _get_query_kind(insight.query)
        try:
            result = await database_sync_to_async(_execute_insight_query, thread_sensitive=False)(
                insight, team, dashboard
            )
            results_summary = build_results_summary(query_kind, result.result)
        except Exception:
            await LOGGER.awarning(
                "snapshot_subscription_insights.query_failed",
                subscription_id=inputs.subscription_id,
                insight_id=insight.id,
                exc_info=True,
            )
            results_summary = "Query execution failed"

        insight_name = insight.name or insight.derived_name or f"Insight {insight.id}"
        current_state = {
            "query_definition": insight.query or {},
            "results_summary": results_summary,
            "timestamp": now,
            "insight_name": insight_name,
        }
        await store_insight_state(redis_client, key, current_state, ttl)

        current_state_dicts.append(
            {
                "insight_id": insight.id,
                "insight_name": insight_name,
                "query_definition": insight.query or {},
                "results_summary": results_summary,
                "timestamp": now,
            }
        )

    summary_text: str | None = None
    if has_any_previous and previous_states:
        try:
            previous_dicts = [
                {
                    "insight_id": s.insight_id,
                    "insight_name": s.insight_name,
                    "query_definition": s.query_definition,
                    "results_summary": s.results_summary,
                    "timestamp": s.timestamp,
                }
                for s in previous_states
            ]
            summary_text = await database_sync_to_async(generate_change_summary, thread_sensitive=False)(
                previous_dicts,
                current_state_dicts,
                subscription_title=subscription.title,
                team_id=inputs.team_id,
            )
        except Exception:
            await LOGGER.awarning(
                "snapshot_subscription_insights.llm_summary_failed",
                subscription_id=inputs.subscription_id,
                exc_info=True,
            )

    await LOGGER.ainfo(
        "snapshot_subscription_insights.completed",
        subscription_id=inputs.subscription_id,
        insight_count=len(insights),
        has_previous=has_any_previous,
        has_summary=summary_text is not None,
    )

    return SnapshotInsightsResult(
        previous_states=previous_states if has_any_previous else None,
        summary_text=summary_text,
    )
