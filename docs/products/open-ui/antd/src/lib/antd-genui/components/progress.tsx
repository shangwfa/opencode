"use client";

import { Space, Typography, Progress as AntdProgress } from "antd";
import { defineComponent } from "@openuidev/react-lang";
import { z } from "zod";

const { Text } = Typography;

const ProgressSchema = z.object({
  value: z.number(),
  label: z.string().optional(),
});

export const Progress = defineComponent({
  name: "Progress",
  props: ProgressSchema,
  description: "Progress bar showing completion percentage (0-100). Optional label.",
  component: ({ props }) => (
    <Space orientation="vertical" size={4} style={{ width: "100%" }}>
      {props.label && (
        <Space style={{ width: "100%", justifyContent: "space-between" }}>
          <Text style={{ fontSize: 13 }}>{props.label}</Text>
          <Text type="secondary" style={{ fontSize: 13 }}>{props.value}%</Text>
        </Space>
      )}
      <AntdProgress percent={props.value} showInfo={false} size="small" />
    </Space>
  ),
});