"use client";

import { DatePicker as AntdDatePicker } from "antd";
import {
  defineComponent,
  useFormName,
  useGetFieldValue,
  useIsStreaming,
  useSetFieldValue,
} from "@openuidev/react-lang";
import dayjs from "dayjs";
import { z } from "zod";

const DatePickerSchema = z.object({
  name: z.string(),
  placeholder: z.string().optional(),
});

export const DatePicker = defineComponent({
  name: "DatePicker",
  props: DatePickerSchema,
  description: "Date selection input with calendar popover.",
  component: ({ props }) => {
    const formName = useFormName();
    const getFieldValue = useGetFieldValue();
    const setFieldValue = useSetFieldValue();
    const isStreaming = useIsStreaming();

    const fieldName = props.name as string;
    const saved = getFieldValue(formName, fieldName) as string | undefined;
    const date = saved ? dayjs(saved) : undefined;

    return (
      <AntdDatePicker
        value={date}
        placeholder={props.placeholder ?? "Pick a date"}
        onChange={(d) => {
          if (d) {
            setFieldValue(formName, "DatePicker", fieldName, d.toISOString(), true);
          }
        }}
        disabled={isStreaming}
        style={{ width: "100%" }}
      />
    );
  },
});