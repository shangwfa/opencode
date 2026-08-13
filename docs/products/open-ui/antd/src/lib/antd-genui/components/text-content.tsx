"use client";

import { Typography } from "antd";
import { defineComponent } from "@openuidev/react-lang";
import { z } from "zod";

const { Text } = Typography;

const TextContentSchema = z.object({
  text: z.string(),
  size: z.enum(["small", "default", "large", "small-heavy", "large-heavy"]).optional(),
});

const sizeMap: Record<string, { fontSize: number; fontWeight: number; color?: string }> = {
  small: { fontSize: 13, fontWeight: 400, color: "var(--ant-color-text-secondary)" },
  default: { fontSize: 14, fontWeight: 400 },
  large: { fontSize: 16, fontWeight: 400 },
  "small-heavy": { fontSize: 13, fontWeight: 600 },
  "large-heavy": { fontSize: 16, fontWeight: 600 },
};

export const TextContent = defineComponent({
  name: "TextContent",
  props: TextContentSchema,
  description:
    'Text block with optional size. size: "small" | "default" | "large" | "small-heavy" | "large-heavy".',
  component: ({ props }) => {
    const text = props.text == null ? "" : String(props.text);
    const style = sizeMap[props.size ?? "default"] ?? sizeMap["default"];
    return <Text style={style}>{text}</Text>;
  },
});