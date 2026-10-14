import type { GetServerSideProps } from "next";
import { Button, Input, List } from "antd";
import Link from "next/link";
import { useRouter } from "next/router";
import { useState } from "react";

import XybotEditor from "@/components/XybotEditor/editor";
import { kbFetch, searchKb, type MenuTreeNode, type SearchHit } from "@/api/docPlatform";

interface Props {
  kbSlug: string;
  kbName: string;
  tree: MenuTreeNode[];
  docId: string | null;
  contentJson: object | null;
  notFound?: string;
}

/** 深度优先取第一篇可读 doc */
function firstDocId(nodes: MenuTreeNode[]): string | null {
  for (const node of nodes) {
    if (node.type === "doc") return node.id;
    const child = firstDocId(node.menuTrees);
    if (child) return child;
  }
  return null;
}

export default function KbBrowsePage(props: Props) {
  const router = useRouter();
  const { kbSlug } = router.query;
  const slug = (props.kbSlug || (kbSlug as string)) ?? "";
  const [collapsed, setCollapsed] = useState(false);
  const [searchQ, setSearchQ] = useState("");
  const [searching, setSearching] = useState(false);
  const [searchResult, setSearchResult] = useState<{ total: number; items: SearchHit[] } | null>(null);

  const onSearch = async () => {
    const q = searchQ.trim();
    if (!q) return;
    setSearching(true);
    try {
      const result = await searchKb(slug, { q, page: 1, pageSize: 10 });
      setSearchResult({ total: result.total, items: result.items });
    } catch {
      setSearchResult({ total: 0, items: [] });
    } finally {
      setSearching(false);
    }
  };

  if (props.notFound) {
    return (
      <div style={{ maxWidth: 560, margin: "120px auto", textAlign: "center" }}>
        <h2>知识库不存在或未公开</h2>
        <Link href="/kb">返回我的知识库</Link>
      </div>
    );
  }

  const renderMenu = (nodes: MenuTreeNode[], depth = 0) =>
    nodes.map((node) => (
      <div key={node.id}>
        {node.type === "doc" ? (
          <Link
            href={{ pathname: `/kb/${slug}`, query: { docId: node.id } }}
            style={{
              display: "block",
              padding: "6px 8px",
              paddingLeft: 8 + depth * 16,
              borderRadius: 6,
              fontWeight: node.id === props.docId ? 600 : 400,
              background: node.id === props.docId ? "#f0f5ff" : undefined,
              color: "inherit",
            }}
          >
            {node.name}
          </Link>
        ) : (
          <div style={{ padding: "6px 8px", paddingLeft: 8 + depth * 16, color: "#999", fontWeight: 600 }}>
            {node.name}
          </div>
        )}
        {node.menuTrees?.length ? renderMenu(node.menuTrees, depth + 1) : null}
      </div>
    ));

  return (
    <div style={{ display: "flex", minHeight: "100vh" }}>
      <div
        style={{
          width: collapsed ? 0 : 260,
          overflowY: "auto",
          borderRight: "1px solid #f0f0f0",
          padding: collapsed ? 0 : 16,
          flexShrink: 0,
        }}
      >
        <div style={{ marginBottom: 12 }}>
          <Link href="/kb">← 我的知识库</Link>
          <h3 style={{ margin: "8px 0 0" }}>{props.kbName}</h3>
        </div>
        <Input.Search
          placeholder="搜索本知识库"
          size="small"
          value={searchQ}
          onChange={(e) => setSearchQ(e.target.value)}
          onSearch={onSearch}
          loading={searching}
          style={{ marginBottom: 12 }}
          allowClear
        />
        {searchResult && (
          <div style={{ marginBottom: 12, maxHeight: 320, overflowY: "auto" }}>
            <div style={{ color: "#999", fontSize: 12, marginBottom: 6 }}>
              找到 {searchResult.total} 条结果
            </div>
            <List
              size="small"
              dataSource={searchResult.items}
              locale={{ emptyText: "无结果" }}
              renderItem={(hit) => (
                <List.Item style={{ padding: "6px 0" }}>
                  <Link
                    href={{ pathname: `/kb/${slug}`, query: { docId: hit.menuId } }}
                    style={{ display: "block", color: "inherit" }}
                    onClick={() => setSearchResult(null)}
                  >
                    <div style={{ fontWeight: 600 }}>{hit.name}</div>
                    <div style={{ fontSize: 12, color: "#999" }}>
                      {hit.path.join(" / ")}
                    </div>
                    <div style={{ fontSize: 12, color: "#666" }}>{hit.snippet}</div>
                  </Link>
                </List.Item>
              )}
            />
            <Button size="small" type="link" onClick={() => setSearchResult(null)}>
              关闭搜索结果
            </Button>
          </div>
        )}
        {renderMenu(props.tree)}
      </div>

      <div style={{ flex: 1, padding: 24, overflowX: "hidden" }}>
        <Button
          size="small"
          onClick={() => setCollapsed(!collapsed)}
          style={{ marginBottom: 12 }}
        >
          {collapsed ? "展开目录" : "收起目录"}
        </Button>
        {props.contentJson ? (
          <XybotEditor
            embedded
            editable={false}
            value={props.contentJson as any}
          />
        ) : (
          <div style={{ color: "#999", marginTop: 80, textAlign: "center" }}>
            该文档尚未发布
          </div>
        )}
      </div>
    </div>
  );
}

export const getServerSideProps: GetServerSideProps<Props> = async (context) => {
  const kbSlug = context.params?.kbSlug as string;
  const docId = (context.query.docId as string) || null;

  const tree = await kbFetch<MenuTreeNode[]>(`/api/doc-platform/kb/${kbSlug}/tree`);
  if (!tree) {
    return { props: { kbSlug, kbName: "", tree: [], docId: null, contentJson: null, notFound: "1" } };
  }

  const targetId = docId || firstDocId(tree);
  let contentJson: object | null = null;
  if (targetId) {
    const content = await kbFetch<{ contentType: string; content: string }>(
      `/api/doc-platform/kb/${kbSlug}/documents/${targetId}/content`,
    );
    if (content?.content) {
      try {
        contentJson = JSON.parse(content.content);
      } catch {
        contentJson = null;
      }
    }
  }

  // 库名:tree 顶层无法直接取(接口不含 meta),用 slug 展示;M2 由接口补充
  return {
    props: {
      kbSlug,
      kbName: kbSlug,
      tree,
      docId: targetId,
      contentJson,
    },
  };
};
