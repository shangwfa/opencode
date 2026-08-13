"use client";

import { Button as AntdButton, Drawer, Space, Typography } from "antd";
import { defineComponent } from "@openuidev/react-lang";
import React from "react";
import { z } from "zod";

const DrawerBlockSchema = z.object({
  triggerLabel: z.string(),
  title: z.string(),
  description: z.string().optional(),
  content: z.array(z.any()).default([]),
});

export const DrawerBlock = defineComponent({
  name: "DrawerBlock",
  props: DrawerBlockSchema,
  description:
    "Bottom drawer panel triggered by a button. triggerLabel: button text, title/description in header, content: children rendered inside.",
  component: ({ props, renderNode }) => {
    const [open, setOpen] = React.useState(false);

    return (
      <>
        <AntdButton onClick={() => setOpen(true)}>
          {props.triggerLabel}
        </AntdButton>
        <Drawer
          title={props.title}
          open={open}
          onClose={() => setOpen(false)}
          placement="bottom"
          height="auto"
        >
          {props.description && (
            <Typography.Text type="secondary" style={{ marginBottom: 16, display: "block" }}>
              {props.description}
            </Typography.Text>
          )}
          <Space orientation="vertical" size={12} style={{ width: "100%" }}>
            {renderNode(props.content)}
          </Space>
        </Drawer>
      </>
    );
  },
});