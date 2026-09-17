"use client";

import { Alert as AntdAlert } from "antd";
import { defineComponent } from "@openuidev/react-lang";
import { InfoCircleOutlined, CheckCircleOutlined, CloseCircleOutlined, WarningOutlined } from "@ant-design/icons";
import { z } from "zod";

const AlertSchema = z.object({
  title: z.string(),
  description: z.string(),
  variant: z.enum(["default", "destructive", "info", "success", "warning"]).optional(),
});

const iconMap: Record<string, React.ReactNode> = {
  info: <InfoCircleOutlined />,
  success: <CheckCircleOutlined />,
  warning: <WarningOutlined />,
  destructive: <CloseCircleOutlined />,
};

const typeMap: Record<string, "info" | "success" | "warning" | "error"> = {
  info: "info",
  success: "success",
  warning: "warning",
  destructive: "error",
  default: "info",
};

export const Alert = defineComponent({
  name: "Alert",
  props: AlertSchema,
  description:
    'Alert banner with icon, title, and description. variant: "default" | "destructive" | "info" | "success" | "warning".',
  component: ({ props }) => {
    const v = props.variant ?? "default";
    const type = typeMap[v] ?? "info";
    const icon = iconMap[v];
    return (
      <AntdAlert
        title={props.title}
        description={props.description}
        type={type}
        showIcon
        icon={icon}
        style={{ borderRadius: 8 }}
      />
    );
  },
});