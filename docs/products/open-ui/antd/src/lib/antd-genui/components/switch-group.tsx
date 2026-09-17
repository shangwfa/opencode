"use client";

import { Switch, Space, Typography } from "antd";
import {
  defineComponent,
  useFormName,
  useGetFieldValue,
  useIsStreaming,
  useSetFieldValue,
} from "@openuidev/react-lang";
import { z } from "zod";

const SwitchItemSchema = z.object({
  value: z.string(),
  label: z.string(),
});

export const SwitchItem = defineComponent({
  name: "SwitchItem",
  props: SwitchItemSchema,
  description: "Toggle option in a SwitchGroup.",
  component: () => null,
});

const SwitchGroupSchema = z.object({
  name: z.string(),
  items: z.array(SwitchItem.ref),
});

export const SwitchGroup = defineComponent({
  name: "SwitchGroup",
  props: SwitchGroupSchema,
  description: "Group of toggle switches. items: SwitchItem[].",
  component: ({ props }) => {
    const formName = useFormName();
    const getFieldValue = useGetFieldValue();
    const setFieldValue = useSetFieldValue();
    const isStreaming = useIsStreaming();

    const fieldName = props.name as string;
    const current = (getFieldValue(formName, fieldName) as string[] | undefined) ?? [];
    const items = (Array.isArray(props.items) ? (props.items as any[]) : []).filter((item) => item?.props?.value);

    return (
      <Space orientation="vertical" size={12} style={{ width: "100%" }}>
        {items.map((item, i) => {
          const val = item.props.value as string;
          const checked = current.includes(val);
          return (
            <Space key={i} style={{ width: "100%", justifyContent: "space-between" }}>
              <Typography.Text>{item.props.label || val}</Typography.Text>
              <Switch
                checked={checked}
                onChange={(c) => {
                  const next = c ? [...current, val] : current.filter((v: string) => v !== val);
                  setFieldValue(formName, "SwitchGroup", fieldName, next, true);
                }}
                disabled={isStreaming}
              />
            </Space>
          );
        })}
      </Space>
    );
  },
});