"use client";

import { Calendar } from "antd";
import type { Dayjs } from "dayjs";
import { defineComponent } from "@openuidev/react-lang";
import React from "react";
import { z } from "zod";

const CalendarBlockSchema = z.object({
  mode: z.enum(["single", "multiple", "range"]).optional(),
  defaultMonth: z.string().optional(),
  numberOfMonths: z.number().optional(),
  captionLayout: z.enum(["label", "dropdown"]).optional(),
});

export const CalendarBlock = defineComponent({
  name: "CalendarBlock",
  props: CalendarBlockSchema,
  description:
    'Standalone calendar display. mode: "single" | "multiple" | "range". captionLayout: "label" | "dropdown" (default "dropdown"). numberOfMonths defaults to 1.',
  component: ({ props }) => {
    const [selected, setSelected] = React.useState<Dayjs | undefined>();
    const [multiSelected, setMultiSelected] = React.useState<Dayjs[]>([]);
    const [range, setRange] = React.useState<[Dayjs | null, Dayjs | null] | null>(null);

    const mode = props.mode ?? "single";
    const defaultMonth = props.defaultMonth ? undefined : undefined;

    const onSelect = (date: Dayjs) => {
      if (mode === "single") {
        setSelected(date);
      } else if (mode === "multiple") {
        setMultiSelected((prev) => {
          const exists = prev.some((d) => d.isSame(date, "day"));
          return exists ? prev.filter((d) => !d.isSame(date, "day")) : [...prev, date];
        });
      } else if (mode === "range") {
        if (!range || range[1]) {
          setRange([date, null]);
        } else {
          setRange([range[0], date]);
        }
      }
    };

    const cellRender = (current: Dayjs) => {
      const isSelected = mode === "single" && selected?.isSame(current, "day");
      const isInRange = range && range[0] && range[1] && current.isAfter(range[0]) && current.isBefore(range[1]);
      const isRangeStart = range?.[0]?.isSame(current, "day");
      const isRangeEnd = range?.[1]?.isSame(current, "day");
      const isMulti = mode === "multiple" && multiSelected.some((d) => d.isSame(current, "day"));

      if (isSelected || isRangeStart || isRangeEnd || isMulti) {
        return (
          <div style={{
            background: "var(--app-primary)",
            color: "#fff",
            borderRadius: 4,
            width: 24,
            height: 24,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
          }}>
            {current.date()}
          </div>
        );
      }
      if (isInRange) {
        return (
          <div style={{
            background: "var(--app-primary-bg)",
            borderRadius: 4,
            width: 24,
            height: 24,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
          }}>
            {current.date()}
          </div>
        );
      }
      return <div style={{ width: 24, height: 24, display: "flex", alignItems: "center", justifyContent: "center" }}>{current.date()}</div>;
    };

    const defaultValue = props.defaultMonth ? undefined : undefined;

    return (
      <div style={{ border: "1px solid var(--ant-color-border)", borderRadius: 8, overflow: "hidden" }}>
        <Calendar
          fullscreen={false}
          onSelect={onSelect}
          cellRender={cellRender}
        />
      </div>
    );
  },
});