# What-if planning and weather

## What-if workflow

Select a saved plan, then use **Plan → What-if planning**. Queue collection additions, removals, and moves; all queued changes apply as one batch. A synchronized collection is always changed as a whole. Start times are seconds after the plan epoch, and participants are spacecraft IDs from that plan.

- **Keep collections; apply my edits** performs only explicit changes.
- **Keep collections; schedule remaining requests** reserves the retained/edited collections, including their future capacity, cooldown, energy/storage costs, and revisit spacing. The scheduler fills the remaining opportunities.
- **Rearrange the entire plan** schedules the modified snapshot from scratch.

**Validate & compare** returns validation and a comparison without saving. **Save valid variant** independently validates the entire proposed plan and saves a new immutable plan only on success. Invalid batches report the failing constraint. Original plans and the live request/fleet catalogs are never changed. A saved variant records its parent and added, removed, rearranged, and retained collections; the UI can reopen the original.

Advanced JSON accepts `add_requests`, `request_changes` (complete request records with IDs), `remove_request_ids`, `spacecraft_changes`, `remove_spacecraft_ids`, and a replacement `scenario`. New request IDs are local to the plan snapshot and returned in job results. Removing a request removes its collections; removing a spacecraft removes every affected synchronized collection in full. Disabling an input while retaining its collection is invalid. A changed time, position, sensor, duration, budget, or weather requirement is revalidated.

Full rescheduling rejects manual collection edits; use edit/fill mode to fix particular commands. The fixed collections are included in the snapshot contract, and the final validator rejects scheduler plugins that drop or move them. Edit-mode unallocated requests are reported as `what_if_not_allocated`; this is not a claim that no feasible opportunity exists.

## MCP

Use `what_if_plan(plan_id, changes)` for atomic batch changes. `changes` uses the same `WhatIfSpec` as REST:

```json
{
  "plan_id": "SOURCE_PLAN_ID",
  "changes": {
    "name": "Move a collection later",
    "mode": "edit",
    "collections": [
      { "action": "move", "collection_id": "12:1", "start_seconds": 600 }
    ],
    "save": false
  }
}
```

Poll `job_status`. A completed preview returns `validation`, `comparison`, and `added_request_ids`. Set `save: true` to create a variant; its ID is returned as `result.plan_id`. Convenience tools are `add_plan_collection`, `remove_plan_collection`, and `move_plan_collection`. Use `compare_plans` for any two saved plans, and the existing explanation/timeline tools for either variant.

REST equivalents: `POST /api/plans/{id}/whatif` and `GET /api/plans/{id}/compare/{other_id}`. Schema resources include `orbit://schema/whatif` and `orbit://schema/weather-refresh`.

## Weather requirements and acquisition

Request fields `max_cloud_cover_pct`, `max_precipitation_mm`, and `max_wind_speed_mps` are nullable; null means unrestricted. Zero is a real limit. The request editor and CSV/JSON import/export support all three. Random generation can optionally vary weather requirements; it still creates requests without testing feasibility.

The initial provider is [Open-Meteo](https://open-meteo.com/en/docs), using real hourly **model forecasts**, including archived forecasts for supported past dates, rather than live observations or invented weather. Coordinates are grouped into explicit 0.25° cells. These cells approximate regional conditions; they are not target-resolution measurements. Unsupported times or provider failures produce an error and preserve previously cached batches.

1. Choose the timeframe in Schedule (use **Use current UTC time** for a current forecast).
2. In Weather, choose the current catalog/timeframe or the selected saved plan.
3. **Refresh forecast cache** downloads hourly cloud cover, precipitation, and 10 m wind. Default is up to 500 new locations; increase up to 10,000 or refresh again for remaining locations. The download job is cancellable between batches and during rate-limit waits.
4. **Show latest cached weather** loads the newest fresh cached cells. **Show plan weather** loads the exact immutable evidence saved with that plan. Switch individual weather layers and adjust opacity under Map layers.
5. Build a plan. Scheduling reads the cache, freezes weather evidence in its input snapshot, and performs no network requests in the search/validation loops. What-if variants retain parent weather by default; **Use latest cached weather** captures a new snapshot when requested.

Weather downloads and scheduling share the existing bounded worker queue and cannot run simultaneously. Download time is separate from the scheduling budget. The default public provider budget is conservatively limited by locations to 550/minute, 4,900/hour, and 9,900/day; large cold-cache workloads may require multiple refreshes after budget renewal. Successful partial batches persist even if a later batch fails. Cache TTL is one hour; saved plans retain their original data after cache expiry/replacement.

The public API is for non-commercial use under its [terms](https://open-meteo.com/en/terms). For another compatible endpoint, configure `ORBIT_WEATHER_URL`; `ORBIT_WEATHER_API_KEY` is read from the environment and never stored in plans. Keep provider attribution when displaying the data. Acquisition lives in `server/weather.py`, independently of ephemeris and rendering.

## Scheduling semantics

New schedules default to `optical_daylight_only: true`: optical collections require solar elevation of at least zero throughout the sampled dwell, regardless of a request's daylight toggle. Stricter enabled request/global daylight limits still apply. Infrared and radar retain their explicit daylight rules. Plans built without the current checks must be rebuilt. Playback identifies them as needing a rebuild. To apply new rules, build a new plan or reschedule a what-if with the updated scenario constraints.

The Schedule panel's **Affected by weather** checkbox enables weather constraints. When checked, optical and infrared requests must satisfy the shared maximum cloud cover (50% by default) and any stricter per-request cloud limit. Radar is unaffected unless it has an explicit weather limit. Unchecking disables weather constraints, including per-request limits, for that new plan. MCP and REST use `scenario.constraints.affected_by_weather` and `max_cloud_cover_pct`. Weather is either enabled or disabled; there is no compatibility mode for older inputs.

Every constrained collection must have weather coverage across its entire duration. Cloud and wind use conservative maxima across the bracketing hourly samples. Precipitation is Open-Meteo's preceding-hour total in millimeters; the same conservative brackets are checked, which can reject a period adjacent to rain. There is no claim of sub-hour weather accuracy.

Missing, stale-at-capture, null, or out-of-range required weather produces `weather_unavailable`; exceeded limits produce `weather`. Unknown weather never becomes clear weather. Unrestricted requests do not require weather coverage. Both scheduler and independent plan validation enforce the same limits. Saved plans replay the evidence as it was at capture time, not the current cache. Moving a request to a different location/timeframe invalidates unmatched weather coverage.

MCP: `refresh_weather`, `query_cached_weather`, and `request_plan_weather`. REST: `POST /api/weather/refresh`, `POST /api/weather/cache`, and `GET /api/plans/{id}/weather`. Cached weather responses include source attribution, fetch/expiry timestamps, coordinates, resolution, and hourly values.

## Viewer layers

The prominent playback dropdown above the bottom plan totals selects any saved plan, including what-if variants. Plans are ordered newest first and labelled with their name and UTC creation timestamp. Saved duplicate names automatically increment (`Observation plan (2)`, `Observation plan (3)`). Selecting the request catalog exits plan playback. Workspace panels stay in a single column directly below their tabs.

The map's Layers button contains the basemap chooser and a cloud-cover toggle. Presets are key-free: offline Natural Earth, Esri satellite imagery, topographic and shaded relief maps, and OpenStreetMap. Google and Bing's supported integrations require credentials and are excluded. Online maps require network access and retain provider credits. Custom XYZ imagery can be added as an overlay.

Cloud cover is an hourly, white, percentage-opacity grid at cached request locations, not a global satellite cloud image. Zero cloud cover is transparent; missing coverage is never depicted as clear weather. The map toggle loads saved weather evidence for a selected plan, or fresh cached weather for the catalog timeframe. When no data exists, it directs the user to the Weather refresh controls. Displaying clouds does not change scheduling constraints.

The renderer-neutral `VisualizationLayer` contract supports time-indexed scalar grids and XYZ imagery. Weather is projected into grid layers in `lib/weather-layers.ts`; the Cesium layer manager does not fetch weather or know the scheduler. Saved-plan weather follows playback. Catalog forecasts use the selected Schedule epoch even while another plan is loaded.

Layers have stable IDs, labels, attribution, visibility, opacity, and ordered placement within their type. Imagery is below scalar data overlays. Add an XYZ URL with `{z}`, `{x}`, and `{y}` placeholders and provider credit in the Weather panel. Configuration currently lasts for the current UI session. Picking weather reports the value, unit, hour, and attribution. Missing cells are not drawn. Scalar meshes rebuild only when the selected hour or layer configuration changes; input order and imagery updates preserve host-owned layers. Adapter destruction removes only its own overlays.

## Verification

Run `.venv/Scripts/python -m pytest -q`, `npm run test:visualization`, `npx tsc --noEmit`, `npm run lint`, and `npm run build`. Regression tests cover atomic what-if edits, immutable originals, future reservations, preview-only jobs, REST/MCP schemas, weather thresholds, cache reuse/staleness, independent validation, and layer ownership/time changes. A single-location real Open-Meteo call was also checked. Browser FPS and third-party imagery service behavior are not measured by these tests.
