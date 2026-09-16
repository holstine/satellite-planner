/** Renderer-neutral inputs. Positions are WGS84 Earth-fixed XYZ meters.
 * Arrays are shared, immutable inputs; callers replace the scene after edits.
 * No API, React, scheduler, database, or Cesium dependency belongs here.
 */
export type VisualInstruction = {
  id: string;
  requestId: number;
  spacecraftIndex: number;
  start: number;
  end: number;
};
export type VisualScene = {
  /** Null for a request catalog; otherwise identifies the saved plan. */
  planId: string | null;
  /** Packed [id, x, y, z, feasible, scheduled] records; catalog flags are 1, 0. */
  targets: Float64Array;
  spacecraft: ReadonlyArray<{
    id: string;
    name: string;
    maxOffNadirDeg: number;
  }>;
  timeline: {
    startUnixMs: number;
    durationSeconds: number;
    sampleStepSeconds: number;
    sampleCount: number;
    /** Layout: (sample, spacecraft, xyz), including the exact final time. */
    positions: Float64Array;
    instructions: readonly VisualInstruction[];
  } | null;
};
export type ViewOptions = {
  targets: boolean;
  lines: boolean;
  cone: boolean;
  horizon: boolean;
  feasibleOnly: boolean;
};
export type ViewState = {
  playing: boolean;
  speed: number;
  selected: number;
  options: ViewOptions;
};
export type VisualFrame = {
  seconds: number;
  unixMs: number | null;
  /** Reused scratch buffer. A renderer must consume it synchronously. */
  spacecraftPositions: Float64Array;
  active: readonly VisualInstruction[];
};
export type RequestPick = { requestId: number; x: number; y: number };
export type ViewerEvents = {
  onSelect: (spacecraftIndex: number) => void;
  /** Coordinates are pixels relative to the visualization host. */
  onHover: (pick: RequestPick | null) => void;
  onRender: () => void;
};
export interface ViewerAdapter {
  setScene(scene: VisualScene): void;
  render(frame: VisualFrame, state: ViewState): void;
  home(): void;
  /** Release only resources owned by this adapter. Safe to call twice. */
  destroy(): void;
}
export type ViewerFactory = (
  container: HTMLElement,
  events: ViewerEvents,
) => ViewerAdapter | Promise<ViewerAdapter>;
export type VisualizationHandle = { seek(seconds: number): void; home(): void };
