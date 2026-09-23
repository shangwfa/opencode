"use client";

import { Tag as AntdTag, Space } from "antd";
import { defineComponent } from "@openuidev/react-lang";
import { z } from "zod";

const TagSchema = z.object({
  text: z.string(),
  variant: z.enum(["default", "secondary", "destructive", "outline", "ghost"]).optional(),
});

const colorMap: Record<string, string> = {
  default: "blue",
  secondary: "default",
  destructive: "red",
  outline: "default",
  ghost: "default",
};

export const UiTag = defineComponent({
  name: "Tag",
  props: TagSchema,
  description: "Styled tag/badge. Used inside TagBlock.",
  component: ({ props }) => (
    <AntdTag color={colorMap[props.variant ?? "secondary"] ?? "default"}>{props.text}</AntdTag>
  ),
});

export const TagBlock = defineComponent({
  name: "TagBlock",
  props: z.object({
    tags: z.array(z.union([z.string(), UiTag.ref])),
  }),
  description: "Group of tags. Accepts string array or Tag references.",
  component: ({ props }) => {
    const tags = (props.tags ?? []) as any[];
    return (
      <Space size={[6, 6]} wrap>
        {tags.map((tag, i) => {
          if (typeof tag === "string") {
            return <AntdTag key={i}>{tag}</AntdTag>;
          }
          const text = String(tag?.props?.text ?? "");
          const variant = tag?.props?.variant ?? "secondary";
          return (
            <AntdTag key={i} color={colorMap[variant] ?? "default"}>
              {text}
            </AntdTag>
          );
        })}
      </Space>
    );
  },
});