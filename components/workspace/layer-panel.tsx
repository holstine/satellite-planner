'use client';
import { useState } from 'react';
import type { VisualizationLayer } from '@/lib/visualization/contracts';
import { Toggle } from './controls';

export default function LayerPanel({
  layers,
  onChange,
}: {
  layers: VisualizationLayer[];
  onChange: (layers: VisualizationLayer[]) => void;
}) {
  const [url, setUrl] = useState(''),
    [label, setLabel] = useState(''),
    [credit, setCredit] = useState('');
  return (
    <section>
      <h3>Map layers</h3>
      <p className="hint">
        Ordering applies within imagery and data overlays. Data overlays render
        above imagery.
      </p>
      {layers.map((layer, index) => (
        <div key={layer.id} className="overlay-controls">
          <Toggle
            label={layer.label}
            checked={layer.visible}
            onChange={(visible) =>
              onChange(
                layers.map((l) => (l.id === layer.id ? { ...l, visible } : l)),
              )
            }
          />
          <label className="field">
            <span>Opacity {Math.round(layer.opacity * 100)}%</span>
            <input
              type="range"
              min={0}
              max={1}
              step={0.05}
              value={layer.opacity}
              onChange={(e) =>
                onChange(
                  layers.map((l) =>
                    l.id === layer.id
                      ? { ...l, opacity: Number(e.target.value) }
                      : l,
                  ),
                )
              }
            />
          </label>
          <div className="inline-controls">
            <button
              className="quiet"
              disabled={index === 0}
              onClick={() => {
                const next = [...layers];
                [next[index - 1], next[index]] = [next[index], next[index - 1]];
                onChange(next);
              }}
            >
              Move down
            </button>
            <button
              className="quiet"
              onClick={() => onChange(layers.filter((l) => l.id !== layer.id))}
            >
              Remove
            </button>
          </div>
        </div>
      ))}
      <details>
        <summary>Add XYZ imagery</summary>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            onChange([
              ...layers,
              {
                id: `imagery:${crypto.randomUUID()}`,
                kind: 'xyz-imagery',
                label: label || 'Imagery overlay',
                url,
                attribution: credit,
                visible: true,
                opacity: 0.65,
              },
            ]);
            setUrl('');
            setLabel('');
            setCredit('');
          }}
        >
          <label className="field">
            <span>Layer name</span>
            <input
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              required
            />
          </label>
          <label className="field">
            <span>Tile URL (with {'{z}/{x}/{y}'})</span>
            <input
              type="url"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              required
              placeholder="https://…/{z}/{x}/{y}.png"
            />
          </label>
          <label className="field">
            <span>Attribution</span>
            <input
              value={credit}
              onChange={(e) => setCredit(e.target.value)}
              required
            />
          </label>
          <button className="quiet" type="submit">
            Add imagery layer
          </button>
        </form>
      </details>
    </section>
  );
}
