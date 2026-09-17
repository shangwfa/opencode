"use client";

import { Space } from "antd";
import { defineComponent } from "@openuidev/react-lang";
import { z } from "zod";
import { Button } from "./button";

const ButtonsSchema = z.object({
  buttons: z.array(Button.ref),
  direction: z.enum(["row", "column"]).optional(),
});

export const Buttons = defineComponent({
  name: "Buttons",
  props: ButtonsSchema,
  description: 'Group of Button components. direction: "row" | "column".',
  component: ({ props, renderNode }) => {
    const dir = props.direction ?? "row";
    return (
      <Space orientation={dir === "column" ? "vertical" : "horizontal"} size="small" wrap>
        {renderNode(props.buttons)}
      </Space>
    );
  },
});