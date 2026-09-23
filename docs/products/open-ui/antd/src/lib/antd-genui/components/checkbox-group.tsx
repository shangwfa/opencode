"use client";

import { Checkbox, Space } from "antd";
import {
  defineComponent,
  useFormName,
  useGetFieldValue,
  useIsStreaming,
  useSetFieldValue,
} from "@openuidev/react-lang";
import { z } from "zod";

const CheckBoxItemSchema = z.object({
  value: z.string(),
  label: z.string(),
});

export const CheckBoxItem = defineComponent({
  name: "CheckBoxItem",
  props: CheckBoxItemSchema,
  description: "Option in a CheckBoxGroup.",
  component: () => null,
});

const CheckBoxGroupSchema = z.object({
  name: z.string(),
  items: z.array(CheckBoxItem.ref),
});

export const CheckBoxGroup = defineComponent({
  name: "CheckBoxGroup",
  props: CheckBoxGroupSchema,
  description: "Multiple checkbox options. items: CheckBoxItem[].",
  component: ({ props }) => {
    const formName = useFormName();
    const getFieldValue = useGetFieldValue();
    const setFieldValue = useSetFieldValue();
    const isStreaming = useIsStreaming();

    const fieldName = props.name as string;
    const current = (getFieldValue(formName, fieldName) as string[] | undefined) ?? [];
    const items = (Array.isArray(props.items) ? (props.items as any[]) : []).filter((item) => item?.props?.value);

    const options = items.map((item) => ({
      value: item.props.value as string,
      label: (item.props.label || item.props.value) as string,
    }));

    return (
      <Checkbox.Group
        value={current}
        onChange={(checkedValues) => {
          setFieldValue(formName, "CheckBoxGroup", fieldName, checkedValues, true);
        }}
        disabled={isStreaming}
        options={options}
      />
    );
  },
});