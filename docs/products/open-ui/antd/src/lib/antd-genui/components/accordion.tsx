"use client";

import { Collapse, Space } from "antd";
import { defineComponent } from "@openuidev/react-lang";
import { RightOutlined } from "@ant-design/icons";
import { z } from "zod";
import { ContentChildUnion } from "../unions";

const AccordionItemSchema = z.object({
  value: z.string(),
  trigger: z.string(),
  content: z.array(ContentChildUnion),
});

export const AccordionItemDef = defineComponent({
  name: "AccordionItem",
  props: AccordionItemSchema,
  description: "Collapsible item inside Accordion. value: unique id, trigger: header text.",
  component: () => null,
});

const AccordionSchema = z.object({
  items: z.array(AccordionItemDef.ref),
  type: z.enum(["single", "multiple"]).optional(),
});

export const Accordion = defineComponent({
  name: "Accordion",
  props: AccordionSchema,
  description: 'Collapsible sections. type: "single" | "multiple". items: AccordionItem[].',
  component: ({ props, renderNode }) => {
    const rawProps = props as { items?: unknown; type?: unknown };
    const items = Array.isArray(rawProps.items)
      ? rawProps.items
      : Array.isArray(rawProps.type)
        ? rawProps.type
        : [];
    const type = rawProps.items === "single" || rawProps.items === "multiple"
      ? rawProps.items
      : rawProps.type === "single" || rawProps.type === "multiple"
        ? rawProps.type
        : "multiple";

    const collapseItems = (items as any[]).map((item, i) => ({
      key: String(item?.props?.value ?? i),
      label: <span style={{ fontSize: 13, fontWeight: 500 }}>{String(item?.props?.trigger ?? "")}</span>,
      children: <Space orientation="vertical" size={10} style={{ width: "100%" }}>{renderNode(item?.props?.content)}</Space>,
    }));

    return (
      <Collapse
        items={collapseItems}
        accordion={type === "single"}
        ghost
        size="small"
        expandIconPlacement="end"
        expandIcon={({ isActive }) => (
          <RightOutlined
            style={{
              fontSize: 12,
              color: "var(--ant-color-text-tertiary)",
              transition: "transform 0.2s ease",
              transform: isActive ? "rotate(90deg)" : "none",
            }}
          />
        )}
        style={{ background: "transparent" }}
      />
    );
  },
});