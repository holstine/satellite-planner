'use client';
import { basemaps } from '@/lib/basemaps';

export default function BasemapPicker({
  value,
  onChange,
}: {
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <div>
      <label className="field">
        <span>Basemap</span>
        <select
          aria-label="Basemap"
          value={value}
          onChange={(event) => onChange(event.target.value)}
        >
          {basemaps.map((basemap) => (
            <option key={basemap.id} value={basemap.id}>
              {basemap.label}
            </option>
          ))}
        </select>
      </label>
    </div>
  );
}
