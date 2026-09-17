"use client";

import { Tabs as ShadcnTabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
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
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
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

    return (
      <ShadcnTabs value={activeTab} onValueChange={setUserSelected} className="gap-3">
        <div className="-mx-1 overflow-x-auto px-1 pb-1 [scrollbar-width:thin]">
          <TabsList className="h-auto min-w-max justify-start gap-1 rounded-xl p-1.5">
            {items.map((item) => {
              const val = String(item.props.value);
              return (
                <TabsTrigger
                  key={val}
                  value={val}
                  className="shrink-0 rounded-lg px-3 py-2 text-sm font-medium whitespace-nowrap data-[state=active]:shadow-sm"
                >
                  {String(item.props.trigger)}
                </TabsTrigger>
              );
            })}
          </TabsList>
        </div>
        {items.map((item) => {
          const val = String(item.props.value);
          return (
            <TabsContent
              key={val}
              value={val}
              className="space-y-3 rounded-xl border bg-muted/20 px-4 py-4 sm:px-5"
            >
              {renderNode(item.props.content)}
            </TabsContent>
          );
        })}
      </ShadcnTabs>
    );
  },
});
