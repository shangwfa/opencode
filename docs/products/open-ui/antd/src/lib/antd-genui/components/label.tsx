"use client";

import { Typography } from "antd";
import { defineComponent } from "@openuidev/react-lang";
import { z } from "zod";

const { Text } = Typography;

const LabelSchema = z.object({
  text: z.string(),
  htmlFor: z.string().optional(),
});

export const Label = defineComponent({
  name: "Label",
  props: LabelSchema,
  description: "Form label. Optionally links to an input via htmlFor.",
  component: ({ props }) => (
    <Text strong style={{ fontSize: 13, display: "block", marginBottom: 4 }}>
      {props.text}
    </Text>
  ),
});