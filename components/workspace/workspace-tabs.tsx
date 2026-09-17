'use client';
import type { ReactNode } from 'react';

const tabs = ['schedule', 'requests', 'fleet', 'plan', 'weather'];

/** A fixed one-column workspace; independent from component-library tab layouts. */
export function WorkspaceTabs({
  value,
  onChange,
  children,
}: {
  value: string;
  onChange: (value: string) => void;
  children: ReactNode;
}) {
  return (
    <div
      className="workspace-tabs"
      style={{ display: 'flex', flexDirection: 'column', minWidth: 0 }}
    >
      <div
        className="main-tabs"
        role="tablist"
        aria-label="Workspace modules"
        aria-orientation="horizontal"
      >
        {tabs.map((tab, index) => (
          <button
            key={tab}
            role="tab"
            id={`workspace-tab-${tab}`}
            aria-controls={`workspace-panel-${tab}`}
            aria-selected={value === tab}
            tabIndex={value === tab ? 0 : -1}
            onClick={() => onChange(tab)}
            onKeyDown={(event) => {
              const next =
                event.key === 'ArrowRight'
                  ? (index + 1) % tabs.length
                  : event.key === 'ArrowLeft'
                    ? (index + tabs.length - 1) % tabs.length
                    : event.key === 'Home'
                      ? 0
                      : event.key === 'End'
                        ? tabs.length - 1
                        : -1;
              if (next < 0) return;
              event.preventDefault();
              onChange(tabs[next]);
              document.getElementById(`workspace-tab-${tabs[next]}`)?.focus();
            }}
          >
            {tab[0].toUpperCase() + tab.slice(1)}
          </button>
        ))}
      </div>
      <div className="workspace-content">{children}</div>
    </div>
  );
}

export function WorkspacePanel({
  value,
  active,
  children,
}: {
  value: string;
  active: string;
  children: ReactNode;
}) {
  return (
    <div
      role="tabpanel"
      id={`workspace-panel-${value}`}
      aria-labelledby={`workspace-tab-${value}`}
      className="panel-scroll"
      hidden={value !== active}
      tabIndex={0}
    >
      {value === active ? children : null}
    </div>
  );
}
