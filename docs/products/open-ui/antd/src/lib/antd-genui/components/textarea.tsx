"use client";

import { Input as AntdInput } from "antd";
import {
  defineComponent,
  parseStructuredRules,
  useFormName,
  useFormValidation,
  useGetFieldValue,
  useIsStreaming,
  useSetFieldValue,
} from "@openuidev/react-lang";
import React from "react";
import { z } from "zod";
import { rulesSchema } from "../rules";

const { TextArea: AntdTextArea } = AntdInput;

const TextareaSchema = z.object({
  name: z.string(),
  placeholder: z.string().optional(),
  rows: z.number().optional(),
  rules: rulesSchema,
});

export const TextArea = defineComponent({
  name: "TextArea",
  props: TextareaSchema,
  description: "Multi-line text input. rows sets visible height. rules for validation.",
  component: ({ props }) => {
    const formName = useFormName();
    const getFieldValue = useGetFieldValue();
    const setFieldValue = useSetFieldValue();
    const isStreaming = useIsStreaming();
    const formValidation = useFormValidation();

    const fieldName = props.name as string;
    const rules = React.useMemo(() => parseStructuredRules(props.rules), [props.rules]);
    const savedValue = getFieldValue(formName, fieldName) ?? "";

    React.useEffect(() => {
      if (!isStreaming && rules.length > 0 && formValidation) {
        formValidation.registerField(fieldName, rules, () => getFieldValue(formName, fieldName));
        return () => formValidation.unregisterField(fieldName);
      }
      return undefined;
    }, [isStreaming, rules.length > 0]);

    return (
      <AntdTextArea
        name={fieldName}
        placeholder={props.placeholder}
        rows={props.rows ?? 3}
        defaultValue={savedValue as string}
        onBlur={(e) => {
          const val = e.target.value;
          if (val !== savedValue) setFieldValue(formName, "TextArea", fieldName, val, true);
          if (rules.length > 0 && formValidation)
            formValidation.validateField(fieldName, val, rules);
        }}
        disabled={isStreaming}
      />
    );
  },
});