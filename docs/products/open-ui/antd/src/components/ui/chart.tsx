"use client";

import React from "react";

export type ChartConfig = Record<string, {
  label?: string;
  color?: string;
}>;

type ChartContainerProps = {
  config: ChartConfig;
  className?: string;
  children: React.ReactNode;
};

export function ChartContainer({ config, className, children }: ChartContainerProps) {
  const style = Object.entries(config).reduce<Record<string, string>>((acc, [key, val]) => {
    if (val.color) acc[`--color-${key}`] = val.color;
    return acc;
  }, {});

  return (
    <div className={className} style={style}>
      {children}
    </div>
  );
}

type ChartTooltipContentProps = {
  active?: boolean;
  payload?: Array<{ name?: string; value?: number; dataKey?: string; color?: string }>;
  label?: string;
  nameKey?: string;
};

export function ChartTooltipContent({ active, payload, label, nameKey }: ChartTooltipContentProps) {
  if (!active || !payload?.length) return null;
  return (
    <div style={{
      background: "var(--ant-color-bg-elevated)",
      border: "1px solid var(--ant-color-border)",
      borderRadius: 8,
      padding: "8px 12px",
      boxShadow: "var(--ant-box-shadow)",
      fontSize: 13,
    }}>
      <div style={{ fontWeight: 600, marginBottom: 4, color: "var(--ant-color-text)" }}>{label}</div>
      {payload.map((entry, i) => (
        <div key={i} style={{ color: entry.color, display: "flex", justifyContent: "space-between", gap: 16 }}>
          <span>{entry.name ?? entry.dataKey}</span>
          <span style={{ fontWeight: 600 }}>{entry.value}</span>
        </div>
      ))}
    </div>
  );
}

export function ChartTooltip() {
  return <ChartTooltipContent />;
}