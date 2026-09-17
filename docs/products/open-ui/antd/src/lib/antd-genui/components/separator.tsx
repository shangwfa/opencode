"use client";

import { Divider } from "antd";
import { defineComponent } from "@openuidev/react-lang";
import { z } from "zod";

const SeparatorSchema = z.object({
  orientation: z.enum(["horizontal", "vertical"]).optional(),
});

export const Separator = defineComponent({
  name: "Separator",
  props: SeparatorSchema,
  description: 'Horizontal or vertical rule. orientation: "horizontal" | "vertical".',
  component: ({ props }) => (
    <Divider type={props.orientation === "vertical" ? "vertical" : "horizontal"} style={{ margin: "4px 0" }} />
  ),
});