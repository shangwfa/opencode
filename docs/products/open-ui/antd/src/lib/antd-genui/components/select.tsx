"use client";

import { Select as AntdSelect } from "antd";
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

const SelectItemSchema = z.object({
  value: z.string(),
  label: z.string(),
});

export const SelectItem = defineComponent({
  name: "SelectItem",
  props: SelectItemSchema,
  description: "Option for Select dropdown.",
  component: () => null,
});

const SelectSchema = z.object({
  name: z.string(),
  items: z.array(SelectItem.ref),
  placeholder: z.string().optional(),
  rules: rulesSchema,
});

export const Select = defineComponent({
  name: "Select",
  props: SelectSchema,
  description: "Dropdown select. items: SelectItem[], placeholder, rules for validation.",
  component: ({ props }) => {
    const formName = useFormName();
    const getFieldValue = useGetFieldValue();
    const setFieldValue = useSetFieldValue();
    const isStreaming = useIsStreaming();
    const formValidation = useFormValidation();

    const fieldName = props.name as string;
    const rules = React.useMemo(() => parseStructuredRules(props.rules), [props.rules]);
    const value = getFieldValue(formName, fieldName) as string | undefined;

    React.useEffect(() => {
      if (!isStreaming && rules.length > 0 && formValidation) {
        formValidation.registerField(fieldName, rules, () => getFieldValue(formName, fieldName));
        return () => formValidation.unregisterField(fieldName);
      }
      return undefined;
    }, [isStreaming, rules.length > 0]);

    const items = (Array.isArray(props.items) ? (props.items as any[]) : []).filter((item) => item?.props?.value);

    return (
      <AntdSelect
        value={value ?? undefined}
        placeholder={props.placeholder ?? "Select..."}
        onChange={(val) => {
          setFieldValue(formName, "Select", fieldName, val, true);
          if (rules.length > 0 && formValidation)
            formValidation.validateField(fieldName, val, rules);
        }}
        disabled={isStreaming}
        style={{ width: "100%" }}
        options={items.map((item) => ({
          value: item.props.value,
          label: item.props.label || item.props.value,
        }))}
      />
    );
  },
});