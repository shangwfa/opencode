"use client";

import { Tag } from "antd";
import { defineComponent } from "@openuidev/react-lang";
import { z } from "zod";

const BadgeSchema = z.object({
  text: z.string(),
  variant: z.enum(["default", "secondary", "destructive", "outline", "ghost", "link"]).optional(),
});

const colorMap: Record<string, string> = {
  default: "blue",
  secondary: "default",
  destructive: "red",
  outline: "default",
  ghost: "default",
  link: "blue",
};

export const AntdBadgeComponent = defineComponent({
  name: "Badge",
  props: BadgeSchema,
  description:
    'Inline label/badge. variant: "default" | "secondary" | "destructive" | "outline" | "ghost" | "link".',
  component: ({ props }) => {
    const color = colorMap[props.variant ?? "default"] ?? "default";
    return <Tag color={color}>{props.text}</Tag>;
  },
});