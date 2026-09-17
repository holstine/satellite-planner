'use client';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type {
  RequestPick,
  LayerPick,
  ViewerFactory,
  VisualizationHandle,
  VisualScene,
  ViewState,
} from '@/lib/visualization/contracts';
import { createPlaybackController } from '@/lib/visualization/playback';

export type ViewerSurfaceProps = ViewState & {
  scene: VisualScene;
  factory: ViewerFactory;
  handle: React.RefObject<VisualizationHandle | null>;
  onTime(seconds: number, fps: number, active: number): void;
  onSelect(index: number): void;
  onHover(pick: RequestPick | null): void;
  onLayerHover?(pick: LayerPick | null): void;
};

/** Lifecycle bridge only. Factories, playback and hover UI are separate modules. */
export default function ViewerSurface(props: ViewerSurfaceProps) {
  const { factory } = props;
  const container = useRef<HTMLDivElement>(null);
  const current = useRef(props);
  const runtime = useRef<ReturnType<typeof createPlaybackController> | null>(
    null,
  );
  const [error, setError] = useState('');
  const [ready, setReady] = useState(false);
  useLayoutEffect(() => {
    current.current = props;
  });
  useEffect(() => {
    let disposed = false;
    let animation = 0;
    let controller: ReturnType<typeof createPlaybackController> | null = null;
    let frames = 0;
    const handle = current.current.handle;
    const initialize = async () => {
      setReady(false);
      setError('');
      try {
        const adapter = await factory(container.current!, {
          onSelect: (index) => {
            if (!disposed) current.current.onSelect(index);
          },
          onHover: (pick) => {
            if (!disposed) current.current.onHover(pick);
          },
          onRender: () => {
            frames++;
          },
          onLayerHover: (pick) => {
            if (!disposed) current.current.onLayerHover?.(pick);
          },
          onError: (message) => {
            if (!disposed) setError(message);
          },
        });
        if (disposed) {
          adapter.destroy();
          return;
        }
        controller = createPlaybackController(adapter);
        controller.setScene(current.current.scene);
        let lastScene = current.current.scene;
        runtime.current = controller;
        let last = performance.now(),
          lastUi = last;
        let reportNext = true;
        handle.current = {
          seek: (seconds) => {
            controller!.seek(seconds);
            reportNext = true;
          },
          home: () => controller!.home(),
        };
        const tick = (now: number) => {
          if (disposed) return;
          try {
            if (lastScene !== current.current.scene) {
              controller!.setScene(current.current.scene);
              lastScene = current.current.scene;
              reportNext = true;
            }
            const frame = controller!.tick(
              (now - last) / 1000,
              current.current,
            );
            last = now;
            if (reportNext || now - lastUi >= 250) {
              current.current.onTime(
                frame.seconds,
                Math.round((frames * 1000) / Math.max(1, now - lastUi)),
                frame.active.length,
              );
              frames = 0;
              lastUi = now;
              reportNext = false;
            }
            animation = requestAnimationFrame(tick);
          } catch (err) {
            setError(String(err));
            handle.current = null;
            controller?.destroy();
            runtime.current = null;
          }
        };
        animation = requestAnimationFrame(tick);
        setReady(true);
      } catch (err) {
        controller?.destroy();
        if (!disposed) setError(String(err));
      }
    };
    void initialize();
    return () => {
      disposed = true;
      cancelAnimationFrame(animation);
      handle.current = null;
      controller?.destroy();
      runtime.current = null;
    };
  }, [factory]);
  useEffect(() => {
    runtime.current?.invalidate();
  }, [
    props.options,
    props.selected,
    props.playing,
    props.speed,
    props.layers,
    props.basemap,
  ]);
  return (
    <>
      <div className="visualization-host" ref={container} />
      {!ready && !error && <div className="globe-notice">Loading viewer…</div>}
      {error && (
        <div role="alert" className="globe-notice">
          {error}
        </div>
      )}
    </>
  );
}
