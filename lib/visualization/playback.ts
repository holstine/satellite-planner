import type {
  VisualFrame,
  VisualScene,
  ViewState,
  ViewerAdapter,
} from './contracts';
import { indexInstructions, sampleInterval } from './timeline.ts';

/** A renderer-independent playback clock and interpolator. No timers or globals. */
export function createPlaybackController(viewer: ViewerAdapter) {
  let scene: VisualScene | null = null;
  let seconds = 0;
  let dirty = true;
  let destroyed = false;
  let activeIndex = indexInstructions<
    NonNullable<VisualScene['timeline']>['instructions'][number]
  >([]);
  let frame: VisualFrame = {
    seconds: 0,
    unixMs: null,
    spacecraftPositions: new Float64Array(),
    active: [],
  };
  return {
    setScene(next: VisualScene) {
      const timeline = next.timeline;
      if (
        timeline &&
        (!Number.isFinite(timeline.startUnixMs) ||
          timeline.durationSeconds <= 0 ||
          timeline.sampleStepSeconds <= 0 ||
          !Number.isInteger(timeline.sampleCount) ||
          timeline.sampleCount < 2 ||
          timeline.positions.length !==
            timeline.sampleCount * next.spacecraft.length * 3 ||
          Math.ceil(timeline.durationSeconds / timeline.sampleStepSeconds) +
            1 !==
            timeline.sampleCount)
      )
        throw new Error('Invalid visualization ephemeris samples');
      scene = next;
      seconds = 0;
      activeIndex = indexInstructions(timeline?.instructions ?? []);
      frame = {
        seconds: 0,
        unixMs: null,
        spacecraftPositions: new Float64Array(next.spacecraft.length * 3),
        active: [],
      };
      viewer.setScene(next);
      dirty = true;
    },
    seek(value: number) {
      seconds = Number.isFinite(value)
        ? Math.max(0, Math.min(value, scene?.timeline?.durationSeconds ?? 0))
        : 0;
      dirty = true;
    },
    invalidate() {
      dirty = true;
    },
    tick(elapsedSeconds: number, state: ViewState) {
      if (destroyed || !scene) return frame;
      const timeline = scene.timeline;
      if (timeline && state.playing) {
        const next = Math.min(
          timeline.durationSeconds,
          seconds +
            Math.max(0, Math.min(elapsedSeconds, 0.25)) *
              Math.max(0, state.speed),
        );
        if (seconds !== next) dirty = true;
        seconds = next;
      }
      if (!dirty) return frame;
      frame.seconds = seconds;
      frame.unixMs = timeline ? timeline.startUnixMs + seconds * 1000 : null;
      frame.active = activeIndex.at(seconds);
      if (timeline) {
        const { index, alpha } = sampleInterval(
          seconds,
          timeline.sampleStepSeconds,
          timeline.sampleCount,
          timeline.durationSeconds,
        );
        const width = frame.spacecraftPositions.length;
        for (let i = 0; i < width; i++) {
          const a = timeline.positions[index * width + i];
          const b = timeline.positions[(index + 1) * width + i];
          frame.spacecraftPositions[i] = a + (b - a) * alpha;
        }
      }
      viewer.render(frame, state);
      dirty = false;
      return frame;
    },
    home() {
      if (!destroyed) viewer.home();
    },
    destroy() {
      if (destroyed) return;
      destroyed = true;
      viewer.destroy();
    },
  };
}
