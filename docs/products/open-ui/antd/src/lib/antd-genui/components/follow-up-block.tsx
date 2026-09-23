"use client";

import { Button, Space } from "antd";
import { defineComponent, useTriggerAction } from "@openuidev/react-lang";
import { z } from "zod";

const FollowUpItemSchema = z.object({
  text: z.string(),
});

export const FollowUpItem = defineComponent({
  name: "FollowUpItem",
  props: FollowUpItemSchema,
  description: "Clickable follow-up suggestion — sends text as user message when clicked.",
  component: () => null,
});

const FollowUpBlockSchema = z.object({
  items: z.array(FollowUpItem.ref),
});

export const FollowUpBlock = defineComponent({
  name: "FollowUpBlock",
  props: FollowUpBlockSchema,
  description: "List of follow-up suggestion chips at the end of a response.",
  component: ({ props }) => {
    const triggerAction = useTriggerAction();
    const items = Array.isArray(props.items) ? (props.items as any[]) : [];

    return (
      <Space size={[8, 8]} wrap>
        {items.map((item, i) => {
          const text = String(item?.props?.text ?? "");
          return (
            <Button key={i} size="small" onClick={() => triggerAction(text)}>
              {text}
            </Button>
          );
        })}
      </Space>
    );
  },
});