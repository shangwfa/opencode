"use client";

import { Pagination } from "antd";
import { defineComponent, useTriggerAction } from "@openuidev/react-lang";
import { z } from "zod";

const PaginationBlockSchema = z.object({
  currentPage: z.number(),
  totalPages: z.number(),
});

export const PaginationBlock = defineComponent({
  name: "PaginationBlock",
  props: PaginationBlockSchema,
  description: "Page navigation. currentPage and totalPages control which pages are shown.",
  component: ({ props }) => {
    const triggerAction = useTriggerAction();
    const current = props.currentPage ?? 1;
    const total = props.totalPages ?? 1;

    return (
      <Pagination
        current={current}
        total={total * 10}
        pageSize={10}
        onChange={(page) => {
          triggerAction(`Go to page ${page}`);
        }}
        size="small"
        showSizeChanger={false}
      />
    );
  },
});