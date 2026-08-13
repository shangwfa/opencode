"use client";

import { Slider as AntdSlider, Space, Typography } from "antd";
import {
  defineComponent,
  useFormName,
  useGetFieldValue,
  useIsStreaming,
  useSetDefaultValue,
  useSetFieldValue,
} from "@openuidev/react-lang";
import { z } from "zod";

const SliderSchema = z.object({
  name: z.string(),
  min: z.number().optional(),
  max: z.number().optional(),
  step: z.number().optional(),
  defaultValue: z.number().optional(),
});

export const Slider = defineComponent({
  name: "Slider",
  props: SliderSchema,
  description: "Range slider input. min, max, step, defaultValue.",
  component: ({ props }) => {
    const formName = useFormName();
    const getFieldValue = useGetFieldValue();
    const setFieldValue = useSetFieldValue();
    const isStreaming = useIsStreaming();

    const fieldName = props.name as string;
    const saved = getFieldValue(formName, fieldName) as number | undefined;
    const val = saved ?? props.defaultValue ?? props.min ?? 0;

    useSetDefaultValue({
      formName: formName ?? "",
      componentType: "Slider",
      name: fieldName,
      existingValue: saved,
      defaultValue: props.defaultValue ?? props.min ?? 0,
      shouldTriggerSaveCallback: true,
    });

    return (
      <Space orientation="vertical" size={4} style={{ width: "100%" }}>
        <Space style={{ width: "100%", justifyContent: "space-between" }}>
          <Typography.Text style={{ fontSize: 13 }}>{fieldName}</Typography.Text>
          <Typography.Text type="secondary" style={{ fontSize: 13 }}>{val}</Typography.Text>
        </Space>
        <AntdSlider
          min={props.min ?? 0}
          max={props.max ?? 100}
          step={props.step ?? 1}
          value={val}
          onChange={(v) => {
            setFieldValue(formName, "Slider", fieldName, v, true);
          }}
          disabled={isStreaming}
        />
      </Space>
    );
  },
});