"use client";

import { Typography } from "antd";
import { defineComponent } from "@openuidev/react-lang";
import { z } from "zod";

const { Title } = Typography;

const HeadingSchema = z.object({
  text: z.string(),
  level: z.enum(["h1", "h2", "h3", "h4"]).optional(),
});

const levelMap: Record<string, 1 | 2 | 3 | 4> = {
  h1: 1,
  h2: 2,
  h3: 3,
  h4: 4,
};

export const Heading = defineComponent({
  name: "Heading",
  props: HeadingSchema,
  description: 'Heading text. level: "h1" | "h2" | "h3" | "h4". Defaults to "h2".',
  component: ({ props }) => {
    const level = levelMap[props.level ?? "h2"] ?? 2;
    return <Title level={level} style={{ margin: 0 }}>{props.text}</Title>;
  },
});

const BlockquoteSchema = z.object({
  text: z.string(),
  cite: z.string().optional(),
});

export const Blockquote = defineComponent({
  name: "Blockquote",
  props: BlockquoteSchema,
  description: "Styled blockquote. Optional cite for attribution.",
  component: ({ props }) => (
    <figure style={{ margin: 0 }}>
      <blockquote
        style={{
          margin: "12px 0",
          borderLeft: "3px solid var(--ant-color-border)",
          paddingLeft: 16,
          color: "var(--ant-color-text-secondary)",
          fontStyle: "italic",
        }}
      >
        {props.text}
      </blockquote>
      {props.cite && (
        <figcaption style={{ paddingLeft: 16, fontSize: 13, color: "var(--ant-color-text-tertiary)" }}>
          — {props.cite}
        </figcaption>
      )}
    </figure>
  ),
});

const InlineCodeSchema = z.object({
  code: z.string(),
});

export const InlineCode = defineComponent({
  name: "InlineCode",
  props: InlineCodeSchema,
  description: "Inline code snippet rendered with monospace font.",
  component: ({ props }) => (
    <code
      style={{
        background: "var(--ant-color-fill-tertiary)",
        borderRadius: 3,
        padding: "0.15em 0.3em",
        fontSize: "0.875em",
        fontFamily: "SF Mono, Monaco, monospace",
      }}
    >
      {props.code}
    </code>
  ),
});