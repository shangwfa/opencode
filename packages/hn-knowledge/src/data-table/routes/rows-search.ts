import { Hono } from 'hono';
import { databaseService } from "../services";
import { RowsSearchRequestSchema } from "../types/database.types";
import {
  runDatabaseRowsSearch,
  type DatabaseRowsSearchResponseBody,
} from "../services/database-rows-search.js";

/**
 * POST /database/:id/rows/search
 * - **filter** only：列条件 SQL 过滤（与 create 列一致）
 * - **query** + 可选 **filter**：对行内容分块后的向量做语义 / 关键词 / 混合检索（RAG chunk；含 HyDE、多查询、多阶段召回、重排等），返回条目的 `text` 为命中块文本
 */

const handdler = async (c: any) => {
  try {
    const datasetId = c.req.param("id");
    const simple = c.req.query("simple");
    const body =
      c.req.method === "POST"
        ? await c.req.json()
        : {
            page: c.req.query("page"),
            pageSize: c.req.query("pageSize"),
            query: c.req.query("query"),
          };
    const validated = RowsSearchRequestSchema.parse(body);

    const outcome = await runDatabaseRowsSearch(
      datasetId,
      validated,
      databaseService,
    );

    if (outcome.status === 404) {
      return c.json(
        {
          code: 404,
          success: false,
          message: (outcome.body as { message: string }).message,
          data: null,
        },
        404,
      );
    }

    if (outcome.status === 400) {
      return c.json(
        {
          code: 400,
          success: false,
          message: (outcome.body as { message: string }).message,
          data: null,
        },
        400,
      );
    }

    const { results, ...d } = outcome.body as DatabaseRowsSearchResponseBody;

    const response = simple
      ? results.map((item) => ({
          name: item.row?.name,
          path: item.row?.path,
        }))
      : results;

    return c.json({
      code: 200,
      success: true,
      message: "Search completed",
      data:
        c.req.method === "POST"
          ? {
              ...d,
              items: results,
            }
          : response,
    });
  } catch (error: any) {
    return c.json(
      {
        code: 400,
        success: false,
        message: error.message || "Search failed",
        data: null,
      },
      400,
    );
  }
};

export const searchDatabaseRows = new Hono().post('/:id/rows/search', handdler);

export const getDatabaseRowsSearch = new Hono().get('/:id/query', handdler);
