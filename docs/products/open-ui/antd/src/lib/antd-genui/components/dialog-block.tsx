"use client";

import React from "react";
import { Button as AntdButton, Modal, Space, Typography } from "antd";
import { defineComponent } from "@openuidev/react-lang";
import { z } from "zod";

const DialogBlockSchema = z.object({
  triggerLabel: z.string(),
  title: z.string(),
  description: z.string().optional(),
  content: z.array(z.any()).default([]),
  triggerVariant: z
    .enum(["default", "destructive", "outline", "secondary", "ghost", "link"])
    .optional(),
});

const variantTypeMap: Record<string, "primary" | "default" | "dashed" | "link" | "text"> = {
  default: "primary",
  destructive: "primary",
  outline: "default",
  secondary: "default",
  ghost: "text",
  link: "link",
};

export const DialogBlock = defineComponent({
  name: "DialogBlock",
  props: DialogBlockSchema,
  description:
    "Modal dialog triggered by a button. triggerLabel: button text, title/description in header, content: children rendered inside.",
  component: ({ props, renderNode }) => {
    const [open, setOpen] = React.useState(false);
    const variant = props.triggerVariant ?? "outline";

    return (
      <>
        <AntdButton
          type={variantTypeMap[variant] ?? "default"}
          danger={variant === "destructive"}
          ghost={variant === "outline" || variant === "secondary"}
          onClick={() => setOpen(true)}
        >
          {props.triggerLabel}
        </AntdButton>
        <Modal
          title={props.title}
          open={open}
          onCancel={() => setOpen(false)}
          footer={null}
        >
          {props.description && (
            <Typography.Text type="secondary" style={{ marginBottom: 16, display: "block" }}>
              {props.description}
            </Typography.Text>
          )}
          <Space orientation="vertical" size={12} style={{ width: "100%" }}>
            {renderNode(props.content)}
          </Space>
        </Modal>
      </>
    );
  },
});