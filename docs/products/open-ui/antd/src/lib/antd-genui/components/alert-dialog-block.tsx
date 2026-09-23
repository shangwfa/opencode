"use client";

import { Button as AntdButton, Modal } from "antd";
import { ExclamationCircleOutlined } from "@ant-design/icons";
import { BuiltinActionType, defineComponent, useTriggerAction } from "@openuidev/react-lang";
import React from "react";
import { z } from "zod";

const AlertDialogBlockSchema = z.object({
  triggerLabel: z.string(),
  title: z.string(),
  description: z.string(),
  confirmLabel: z.string().optional(),
  cancelLabel: z.string().optional(),
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

export const AlertDialogBlock = defineComponent({
  name: "AlertDialogBlock",
  props: AlertDialogBlockSchema,
  description:
    "Confirmation dialog with cancel and confirm buttons. Clicking confirm sends the confirmLabel as a message.",
  component: ({ props }) => {
    const triggerAction = useTriggerAction();
    const confirmLabel = props.confirmLabel ?? "Continue";
    const cancelLabel = props.cancelLabel ?? "Cancel";
    const variant = props.triggerVariant ?? "outline";

    const showConfirm = () => {
      Modal.confirm({
        title: props.title,
        icon: <ExclamationCircleOutlined />,
        content: props.description,
        okText: confirmLabel,
        cancelText: cancelLabel,
        onOk: () => {
          triggerAction(confirmLabel, undefined, {
            type: BuiltinActionType.ContinueConversation,
          });
        },
      });
    };

    return (
      <AntdButton
        type={variantTypeMap[variant] ?? "default"}
        danger={variant === "destructive"}
        ghost={variant === "outline" || variant === "secondary"}
        onClick={showConfirm}
      >
        {props.triggerLabel}
      </AntdButton>
    );
  },
});