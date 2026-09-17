'use client';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  api,
  type Explanation,
  type Target,
  type Playback,
} from '@/lib/orbit-api';
import { sceneFromPlan } from '@/lib/visualization/from-plan';
import type { RequestPick, LayerPick } from '@/lib/visualization/contracts';
import ViewerSurface, { type ViewerSurfaceProps } from './viewer-surface';
import { CollectionDetails } from '../workspace/plan-panel';

type Props = Omit<ViewerSurfaceProps, 'scene' | 'onHover'> & {
  points: Float64Array | null;
  playback: Playback | null;
};

/** Application glue: REST projection and request inspection stay outside renderers. */
export default function PlanVisualization({
  points,
  playback,
  ...props
}: Props) {
  const root = useRef<HTMLDivElement>(null);
  const [layerPick, setLayerPick] = useState<LayerPick | null>(null);
  const scene = useMemo(
    () => sceneFromPlan(playback, points),
    [playback, points],
  );
  const [result, setHover] = useState<{
    scene: typeof scene;
    pick: RequestPick;
    value?: Explanation | Target;
    error?: string;
  } | null>(null);
  const cache = useRef(new Map<string, Explanation | Target>());
  const generation = useRef({ value: 0 });
  useEffect(() => {
    cache.current.clear();
    const pending = generation.current;
    pending.value++;
    return () => {
      pending.value++;
    };
  }, [scene]);
  const onHover = useCallback(
    (pick: RequestPick | null) => {
      const requestGeneration = ++generation.current.value;
      if (!pick) {
        setHover(null);
        return;
      }
      const anchored = {
        ...pick,
        x: Math.max(
          12,
          Math.min(pick.x + 18, (root.current?.clientWidth ?? 0) - 326),
        ),
        y: Math.max(
          12,
          Math.min(pick.y + 16, (root.current?.clientHeight ?? 0) - 360),
        ),
      };
      const key = `${scene.planId ?? 'catalog'}:${pick.requestId}`;
      const cached = cache.current.get(key);
      setHover({ scene, pick: anchored, value: cached });
      if (cached) return;
      const path = scene.planId
        ? `/plans/${scene.planId}/requests/${pick.requestId}`
        : `/requests/${pick.requestId}`;
      void api<Explanation | Target>(path)
        .then((value) => {
          if (generation.current.value !== requestGeneration) return;
          if (cache.current.size >= 128)
            cache.current.delete(cache.current.keys().next().value!);
          cache.current.set(key, value);
          setHover({ scene, pick: anchored, value });
        })
        .catch((error) => {
          if (generation.current.value === requestGeneration)
            setHover({ scene, pick: anchored, error: String(error) });
        });
    },
    [scene],
  );
  const hover = result?.scene === scene ? result : null;
  const value = hover?.value;
  return (
    <div className="globe-root" ref={root}>
      <ViewerSurface
        {...props}
        scene={scene}
        onHover={onHover}
        onLayerHover={setLayerPick}
      />
      {layerPick && (
        <div
          className="target-hover"
          role="tooltip"
          style={{ left: layerPick.x + 12, top: layerPick.y + 12 }}
        >
          <h3>{layerPick.label}</h3>
          <p>
            {layerPick.value} {layerPick.unit}
          </p>
          <p>{new Date(layerPick.timeUnixMs).toISOString()}</p>
          <small>{layerPick.attribution}</small>
        </div>
      )}
      {hover && (
        <div
          className="target-hover"
          role="tooltip"
          style={{
            left: hover.pick.x,
            top: hover.pick.y,
          }}
        >
          {value && 'decision' in value ? (
            <CollectionDetails detail={value} />
          ) : value ? (
            <>
              <span className="eyebrow">CATALOG REQUEST</span>
              <h3>{value.name}</h3>
              <p>
                {value.duration_seconds}s · {value.satellites_required}{' '}
                simultaneous spacecraft · {value.energy_wh} Wh / sat
              </p>
              <p>
                {value.collections_required} collections requested ·{' '}
                {value.sensor}
              </p>
              <small>
                Build a plan to see collection times and scheduling decisions.
              </small>
            </>
          ) : (
            <p>{hover.error ?? 'Loading collection details…'}</p>
          )}
        </div>
      )}
    </div>
  );
}
