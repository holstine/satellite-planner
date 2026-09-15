'use client';
import { Switch } from '@/components/ui/switch';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';

export function Numeric({
  label,
  value,
  onChange,
  min,
  max,
  step = 1,
}: {
  label: string;
  value: number;
  onChange: (n: number) => void;
  min?: number;
  max?: number;
  step?: number;
}) {
  return (
    <label className="field">
      <span>{label}</span>
      <input
        type="number"
        required
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
      />
    </label>
  );
}
export function Toggle({
  label,
  checked,
  onChange,
}: {
  label: string;
  checked: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <label className="toggle">
      <span>{label}</span>
      <Switch checked={checked} onCheckedChange={onChange} aria-label={label} />
    </label>
  );
}
export function Choice({
  label,
  value,
  onChange,
  items,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  items: { value: string; label: string }[];
}) {
  return (
    <Select
      value={value}
      onValueChange={(v) => v !== null && onChange(v)}
      items={items}
    >
      <SelectTrigger aria-label={label}>
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {items.map((i) => (
          <SelectItem key={i.value} value={i.value}>
            {i.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
export function Pager({
  offset,
  total,
  size = 25,
  onChange,
}: {
  offset: number;
  total: number;
  size?: number;
  onChange: (offset: number) => void;
}) {
  return (
    <div className="pagination">
      <button
        disabled={!offset}
        onClick={() => onChange(Math.max(0, offset - size))}
      >
        ← Previous
      </button>
      <span>
        {total ? offset + 1 : 0}–{Math.min(offset + size, total)} /{' '}
        {total.toLocaleString()}
      </span>
      <button
        disabled={offset + size >= total}
        onClick={() => onChange(offset + size)}
      >
        Next →
      </button>
    </div>
  );
}
export type Act = (fn: () => Promise<void>) => Promise<void>;
