"use client";

import { Radio } from "antd";
import {
  defineComponent,
  useFormName,
  useGetFieldValue,
  useIsStreaming,
  useSetFieldValue,
} from "@openuidev/react-lang";
import { z } from "zod";

const RadioItemSchema = z.object({
  value: z.string(),
  label: z.string(),
});

export const RadioItem = defineComponent({
  name: "RadioItem",
  props: RadioItemSchema,
  description: "Option in a RadioGroup.",
  component: () => null,
});

const RadioGroupSchema = z.object({
  name: z.string(),
  items: z.array(RadioItem.ref),
});

export const RadioGroup = defineComponent({
  name: "RadioGroup",
  props: RadioGroupSchema,
  description: "Radio selection group. items: RadioItem[].",
  component: ({ props }) => {
    const formName = useFormName();
    const getFieldValue = useGetFieldValue();
    const setFieldValue = useSetFieldValue();
    const isStreaming = useIsStreaming();

    const fieldName = props.name as string;
    const value = (getFieldValue(formName, fieldName) as string | undefined) ?? "";
    const items = (Array.isArray(props.items) ? (props.items as any[]) : []).filter((item) => item?.props?.value);

    const options = items.map((item) => ({
      value: item.props.value as string,
      label: (item.props.label || item.props.value) as string,
    }));

    return (
      <Radio.Group
        value={value || undefined}
        onChange={(e) => {
          setFieldValue(formName, "RadioGroup", fieldName, e.target.value, true);
        }}
        disabled={isStreaming}
        options={options}
      />
    );
  },
});