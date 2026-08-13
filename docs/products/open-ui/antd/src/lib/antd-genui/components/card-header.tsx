"use client";

import { Card } from "antd";
import { defineComponent } from "@openuidev/react-lang";
import { z } from "zod";

const CardHeaderSchema = z.object({
  title: z.string(),
  description: z.string().optional(),
});

export const CardHeader = defineComponent({
  name: "CardHeader",
  props: CardHeaderSchema,
  description: "Title/description header block for a Card.",
  component: ({ props }) => (
    <Card.Meta
      title={props.title}
      description={props.description}
      style={{ paddingBottom: 0 }}
    />
  ),
});