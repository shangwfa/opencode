"use client";

import { Table as AntdTable } from "antd";
import { defineComponent } from "@openuidev/react-lang";
import { z } from "zod";

const ColSchema = z.object({
  header: z.string(),
  type: z.enum(["string", "number", "boolean"]).optional(),
});

export const Col = defineComponent({
  name: "Col",
  props: ColSchema,
  description: "Column definition for Table — header label and optional type.",
  component: () => null,
});

const TableSchema = z.object({
  columns: z.array(Col.ref),
  rows: z.array(z.array(z.any())),
});

export const Table = defineComponent({
  name: "Table",
  props: TableSchema,
  description: "Data table. columns: Col[] with header/type, rows: 2D array of values.",
  component: ({ props }) => {
    const columns = ((props.columns ?? []) as any[]).map((c) => ({
      title: String(c?.props?.header ?? ""),
      dataIndex: c?.props?.header ?? "",
      key: c?.props?.header ?? "",
      align: c?.props?.type === "number" ? "right" as const : "left" as const,
    }));
    const rows = (props.rows ?? []) as unknown[][];

    const dataSource = rows.map((row, ri) => {
      const record: Record<string, unknown> = { key: ri };
      columns.forEach((col, ci) => {
        record[col.dataIndex] = row[ci] ?? "";
      });
      return record;
    });

    return (
      <AntdTable
        columns={columns}
        dataSource={dataSource}
        pagination={false}
        size="small"
        bordered
        style={{ borderRadius: 8 }}
      />
    );
  },
});