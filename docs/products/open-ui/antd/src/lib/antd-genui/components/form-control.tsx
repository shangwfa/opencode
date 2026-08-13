"use client";

import { Typography, Space } from "antd";
import {
  defineComponent,
  useFormValidation,
} from "@openuidev/react-lang";
import { z } from "zod";

const { Text } = Typography;

const FormControlSchema = z.object({
  label: z.string(),
  field: z.any(),
});

export const FormControl = defineComponent({
  name: "FormControl",
  props: FormControlSchema,
  description: "Wraps a form field with a label and error display.",
  component: ({ props, renderNode }) => {
    const formValidation = useFormValidation();
    const fieldName = (props.field as any)?.props?.name as string | undefined;
    const error = fieldName ? formValidation?.errors?.[fieldName] : undefined;

    return (
      <Space orientation="vertical" size={4} style={{ width: "100%" }}>
        <Text strong style={{ fontSize: 13 }}>
          {props.label}
        </Text>
        {renderNode(props.field)}
        {error && (
          <Text type="danger" style={{ fontSize: 12 }}>
            {error}
          </Text>
        )}
      </Space>
    );
  },
});