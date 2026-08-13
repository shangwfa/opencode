"use client";

import { Tabs as AntdTabs } from "antd";
import { defineComponent } from "@openuidev/react-lang";
import * as React from "react";
import { z } from "zod";
import { ContentChildUnion } from "../unions";

const TabItemSchema = z.object({
  value: z.string(),
  trigger: z.string(),
  content: z.array(ContentChildUnion),
});

export const TabItem = defineComponent({
  name: "TabItem",
  props: TabItemSchema,
  description: "Tab panel. value: unique id, trigger: tab label, content: children.",
  component: () => null,
});

const TabsSchema = z.object({
  items: z.array(TabItem.ref),
  defaultValue: z.string().optional(),
});

export const Tabs = defineComponent({
  name: "Tabs",
  props: TabsSchema,
  description: "Tabbed content. items: TabItem[]. defaultValue: initially active tab.",
  component: ({ props, renderNode }) => {
    const rawItems = Array.isArray(props.items) ? (props.items as any[]) : [];

    const items = rawItems.filter(
      (item) => item?.props?.value != null && item?.props?.trigger != null,
    );

    const [userSelected, setUserSelected] = React.useState<string | null>(null);

    const firstValue = items[0]?.props?.value as string | undefined;
    const preferredDefault = props.defaultValue ?? firstValue;

    const userSelectionValid =
      userSelected != null && items.some((item) => String(item?.props?.value) === userSelected);
    const activeTab = userSelectionValid ? userSelected : (preferredDefault ?? "");

    if (items.length === 0) return null;

    const tabItems = items.map((item) => ({
      key: String(item.props.value),
      label: String(item.props.trigger),
      children: (
        <div style={{ padding: "8px 0" }}>
          {renderNode(item.props.content)}
        </div>
      ),
    }));

    return (
      <AntdTabs
        activeKey={activeTab}
        onChange={setUserSelected}
        items={tabItems}
        size="small"
      />
    );
  },
});