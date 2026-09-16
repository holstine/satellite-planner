# Visualization boundary

Fleet, request processing, scheduling, plan storage, and visualization have separate responsibilities. The server's `EphemerisProvider`, `Scheduler`, and `Repository` protocols remain the backend extension points. This change establishes the corresponding viewer boundary without changing scheduling policy, persistence, or REST/MCP contracts.

```text
Fleet / requests -> scheduler -> saved plan / decisions (server)
                                    |
                              REST artifacts
                                    |
                        sceneFromPlan (application projection)
                                    |
                           VisualScene (neutral data)
                                    |
                       playback controller (time/interpolation)
                                    |
                     ViewerAdapter (Cesium or another renderer)

Viewer pick -> application request inspection -> REST plan explanation
```

## Modules

| Module                                                           | Owns                                                                                            |
| ---------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| `lib/visualization/contracts.ts`                                 | Public scene, frame, view state, events, and adapter contracts; no framework or backend imports |
| `lib/visualization/from-plan.ts`                                 | Projection from REST plan artifacts/catalog into the scene contract                             |
| `lib/visualization/playback.ts`, `timeline.ts`                   | Clock advancement, seek, sample interpolation, and active collection lookup                     |
| `lib/visualization/cesium/adapter.ts`                            | Batched primitives, solid cone geometry, horizon, collection lines, and picking                 |
| `lib/visualization/cesium/factory.ts`, `loader.ts`, `viewer.css` | Bundled Cesium viewer creation, SDK loading, imagery, CSS, and owned-viewer disposal            |
| `components/visualization/viewer-surface.tsx`                    | React lifecycle, animation scheduling, status, and command handle                               |
| `components/visualization/plan-visualization.tsx`                | Application projection and cached request/collection hover details through REST                 |
| `app/page.tsx`                                                   | Composition: selects the viewer factory and passes it into `Planner`                            |

Renderers never fetch targets, schedule requests, query the database, or know the full plan/API model. They emit request IDs and spacecraft indices; the application resolves inspection details. No Cesium object crosses the public contract.

## Use another Cesium viewer

Supply the host's Cesium SDK instance and its existing `Viewer` to `attachCesiumViewer`. Importing the adapter does not load the bundled SDK or its stylesheet. Use the same SDK version/instance that created the host viewer.

```ts
import type { ViewerFactory } from './lib/visualization/contracts';
import { attachCesiumViewer } from './lib/visualization/cesium/adapter';

// Define this factory once, outside React render (or memoize it).
const hostViewerFactory: ViewerFactory = async (container, events) => {
  // Your host's integration supplies the already-created Viewer in this
  // container and retains ownership of its lifecycle.
  const { Cesium, viewer } = await host.getViewer(container);
  return attachCesiumViewer(Cesium, viewer, events);
};

// At the app composition point:
// <Planner viewerFactory={hostViewerFactory} />
```

The host canvas should fill the provided container so hover coordinates align with the application overlay. If your viewer lives elsewhere, use the adapter directly and place inspection UI in the host canvas coordinate space.

Attachment adds one private primitive collection and separate input/render listeners. Picks from other layers are ignored. Mounting does not alter the host camera, imagery, lighting, render loop, or clock. `destroy()` removes only the adapter's collection and listeners; it does not destroy the host viewer. Detach before destroying the host viewer. The host must render normally (its existing default or custom render loop); the adapter requests redraws but does not call `viewer.render()`.

The optional settings argument supports `synchronizeClock: true` when the host explicitly delegates its clock to plan playback. The bundled viewer opts in for sunlight. The `home` callback can delegate the reset-view command to the host. Otherwise an explicit `home()` command flies to the standard Earth view.

## Use another renderer

Implement `ViewerFactory(container, events)` returning an adapter with four methods:

- `setScene(scene)`: load immutable scene data when it changes.
- `render(frame, state)`: consume the current positions/active collections and display options synchronously.
- `home()`: reset the view on command.
- `destroy()`: release owned resources, safely if called twice.

Emit `events.onSelect(index)`, `events.onHover({ requestId, x, y })` or `null`, and `events.onRender()` after actual draws. Factories may be asynchronous; the surface disposes late results if it was unmounted or the factory changed. Keep the factory reference stable during normal React renders.

`VisualScene` uses WGS84 Earth-fixed XYZ meters. Its timeline has a UTC epoch in Unix milliseconds, duration and sample step in seconds, and positions packed as `(sample, spacecraft, xyz)`. Samples start at zero and include the exact final time; the final interval may be shorter. Target records are `[id, x, y, z, feasible, scheduled]`. Catalog targets have display flags `1, 0`; those flags do not make feasibility decisions. Instructions reference the scene's spacecraft array and use half-open `[start, end)` intervals in seconds from the epoch.

The application projection shares plan binary arrays without copying. Treat scene arrays as immutable and replace the scene when its data changes. Frame position buffers are reused for performance; a renderer that needs to retain a frame must copy it. Display options and selected spacecraft do not rebuild the scene. Collection lookup uses an interval index; paused, unchanged playback does not interpolate or submit a new frame. Cesium keeps batched points and pooled lines, and limits animated cone geometry updates to five per wall-clock second.

For non-React integration, instantiate `createPlaybackController(adapter)`, call `setScene`, then call `tick(elapsedSeconds, viewState)` from the host's animation loop. Call `invalidate()` after changing display state while paused, `seek(seconds)` for jumps, and `destroy()` on detach. Do not also run `ViewerSurface`'s clock for the same adapter.

## Verification

Run `npm run test:visualization`, `npx tsc --noEmit`, `npm run lint`, and `npm run build`. Tests cover a replacement viewer with no Cesium dependency, interpolation including the short final interval, forward/reverse seeks, catalog/plan transitions, shared buffers, and real Cesium primitive creation and disposal against a lightweight host stub. They verify foreign layers/clock are preserved and cone geometry is solid. These checks do not measure browser FPS or guarantee compatibility with every third-party viewer wrapper; those wrappers need an integration factory as above.
