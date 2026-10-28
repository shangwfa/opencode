import { Button, Input, Modal, Space, Tag, Tree, message } from "antd";
import type { DataNode } from "antd/es/tree";
import Link from "next/link";
import { useRouter } from "next/router";
import { useCallback, useEffect, useMemo, useState } from "react";

import XybotEditor from "@/components/XybotEditor/editor";
import BaseSessionGate from "@/components/BaseSessionGate";
import type { GetServerSideProps } from "next";

// 兼容已有书签，入口统一回到原帮助中心页面，不再展示这套管理壳。
export const getServerSideProps: GetServerSideProps = async ({ params, query }) => {
  const baseId = String(params?.kbSlug ?? "");
  const menuId = typeof query.menuId === "string" ? `/${encodeURIComponent(query.menuId)}` : "";
  return { redirect: { destination: `/${encodeURIComponent(baseId)}/zh-cn${menuId}?from=boss`, permanent: false } };
};
import {
  createMenu,
  deleteMenu,
  getAdminDocument,
  getAdminMenuTree,
  publishDocument,
  saveDraft,
  setMenuEnable,
  type KnowledgeBaseItem,
  type MenuTreeNode,
} from "@/api/docPlatform";

/** MenuTreeNode → antd TreeData(folder 展开子级,doc 可选中编辑) */
function toTreeData(nodes: MenuTreeNode[]): DataNode[] {
  return nodes.map((node) => ({
    key: node.id,
    title: `${node.type === "folder" ? "📁" : "📄"} ${node.name}${node.enable ? "" : " (已隐藏)"}`,
    children: node.menuTrees?.length ? toTreeData(node.menuTrees) : undefined,
  }));
}

/** 在树中找节点 */
function findNode(nodes: MenuTreeNode[], id: string): MenuTreeNode | null {
  for (const node of nodes) {
    if (node.id === id) return node;
    const hit = findNode(node.menuTrees ?? [], id);
    if (hit) return hit;
  }
  return null;
}

/** 找到 folder 的挂载 parentId:选中 folder → 其 id;选中文档 → 其父;无选中 → 根 */
function resolveParentId(nodes: MenuTreeNode[], selectedId: string | null): string | null {
  if (!selectedId) return null;
  const node = findNode(nodes, selectedId);
  if (!node) return null;
  return node.type === "folder" ? node.id : node.parentId;
}

export default function KbAdminPage() {
  return <BaseSessionGate><KbAdminContent /></BaseSessionGate>;
}

function KbAdminContent() {
  const router = useRouter();
  const kbSlug = router.query.kbSlug as string;

  const [kb, setKb] = useState<KnowledgeBaseItem | null>(null);
  const [tree, setTree] = useState<MenuTreeNode[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [selectedType, setSelectedType] = useState<"folder" | "doc" | null>(null);

  const [docStatus, setDocStatus] = useState<string>("");
  const [editorJson, setEditorJson] = useState<object | null>(null);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);

  const refreshTree = useCallback(async () => {
    if (!kb) return;
    const next = await getAdminMenuTree(kb.id).catch(() => null);
    setTree(next ?? []);
  }, [kb]);

  // 初始化:按 slug 查 KB(管理接口按 id 操作,这里复用列表接口找 slug)
  useEffect(() => {
    if (!kbSlug) return;
    import("@/api/docPlatform").then(({ listKnowledgeBases }) =>
      listKnowledgeBases()
        .then((list) => {
          const found = list.find((k) => k.id === kbSlug || k.slug === kbSlug) ?? null;
          if (!found) {
            message.error(`知识库不存在: ${kbSlug}`);
            return;
          }
          setKb(found);
        })
        .catch((e) => message.error(e?.message || "加载失败")),
    );
  }, [kbSlug]);

  useEffect(() => {
    refreshTree();
  }, [refreshTree]);

  useEffect(() => {
    const id = typeof router.query.menuId === "string" ? router.query.menuId : null;
    if (id && !selectedId && findNode(tree, id)?.type === "doc") {
      setSelectedId(id);
      setSelectedType("doc");
    }
  }, [router.query.menuId, tree, selectedId]);

  // 选中节点变化:加载文档内容(doc 才加载)
  useEffect(() => {
    if (!kb || !selectedId || selectedType !== "doc") {
      setEditorJson(null);
      setDocStatus("");
      return;
    }
    let active = true;
    setLoading(true);
    setEditorJson(null);
    getAdminDocument(kb.id, selectedId)
      .then((doc) => {
        if (!active) return;
        setEditorJson((doc.draftContentJson ?? doc.contentJson ?? { type: "doc", content: [{ type: "paragraph" }] }) as object);
        setDocStatus(doc.status);
      })
      .catch((e) => { if (active) message.error(e?.message || "加载文档失败"); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [kb, selectedId, selectedType]);

  const onCreate = (type: "folder" | "doc") => {
    if (!kb) return;
    Modal.confirm({
      title: `新建${type === "folder" ? "文件夹" : "文档"}`,
      content: (
        <Input
          id="kb-admin-new-name"
          placeholder="名称"
          autoFocus
        />
      ),
      onOk: async () => {
        const input = document.getElementById("kb-admin-new-name") as HTMLInputElement | null;
        const name = input?.value.trim();
        if (!name) {
          message.warning("请输入名称");
          return Promise.reject();
        }
        const parentId = resolveParentId(tree, selectedId);
        try {
          const created = await createMenu(kb.id, { name, type, parentId }) as { id: string };
          await refreshTree();
          setSelectedId(created.id);
          setSelectedType(type);
          message.success("已创建");
        } catch (e: any) {
          message.error(e?.message || "创建失败");
        }
      },
    });
  };

  const onDelete = () => {
    if (!kb || !selectedId) return message.warning("请先选择节点");
    Modal.confirm({
      title: "删除节点及其子节点?",
      content: "文档与向量数据将一并删除,不可恢复。",
      okType: "danger",
      onOk: async () => {
        try {
          await deleteMenu(kb.id, selectedId);
          setSelectedId(null);
          await refreshTree();
          message.success("已删除");
        } catch (e: any) {
          message.error(e?.message || "删除失败");
        }
      },
    });
  };

  const onToggleEnable = async () => {
    if (!kb || !selectedId) return;
    const node = findNode(tree, selectedId);
    try {
      await setMenuEnable(kb.id, selectedId, !node?.enable);
      await refreshTree();
    } catch (e: any) {
      message.error(e?.message || "操作失败");
    }
  };

  const onSaveDraft = async () => {
    if (!kb || !selectedId || selectedType !== "doc") return;
    if (!editorJson) return message.warning("暂无内容");
    setSaving(true);
    try {
      await saveDraft(kb.id, selectedId, { contentJson: editorJson, contentType: "tiptap" });
      const latest = await getAdminDocument(kb.id, selectedId);
      setDocStatus(latest.status);
      message.success("草稿已保存");
    } catch (e: any) {
      message.error(e?.message || "保存失败");
    } finally {
      setSaving(false);
    }
  };

  const onPublish = async () => {
    if (!kb || !selectedId || selectedType !== "doc") return;
    if (!editorJson) return message.warning("暂无内容");
    setSaving(true);
    try {
      const doc = await publishDocument(kb.id, selectedId, {
        contentJson: editorJson,
        contentType: "tiptap",
      });
      setDocStatus(doc.status);
      message.success("已发布,正在异步派生到检索库");
      // 轮询一次派生状态(rag 向量化为异步)
      setTimeout(async () => {
        try {
          const latest = await getAdminDocument(kb.id, selectedId);
          setDocStatus(latest.status);
        } catch {
          /* 忽略 */
        }
      }, 2500);
    } catch (e: any) {
      message.error(e?.message || "发布失败");
    } finally {
      setSaving(false);
    }
  };

  const treeData = useMemo(() => toTreeData(tree), [tree]);
  const selectedNode = selectedId ? findNode(tree, selectedId) : null;

  return (
    <div style={{ display: "flex", minHeight: "100vh" }}>
      <div style={{ width: 300, borderRight: "1px solid #f0f0f0", padding: 16, flexShrink: 0, overflowY: "auto" }}>
        <a href={`${process.env.NEXT_PUBLIC_HN_APP_URL || "http://localhost:3001"}/#/knowledge/bases/${encodeURIComponent(kb?.id || kbSlug || "")}`}>← 返回知识库</a>
        <h3 style={{ margin: "8px 0" }}>{kb?.name || kbSlug} · 管理</h3>
        <Space size={4} wrap style={{ marginBottom: 12 }}>
          <Button size="small" onClick={() => onCreate("folder")}>
            +文件夹
          </Button>
          <Button size="small" type="primary" onClick={() => onCreate("doc")}>
            +文档
          </Button>
          <Button size="small" danger disabled={!selectedId} onClick={onDelete}>
            删除
          </Button>
          <Button size="small" disabled={!selectedId} onClick={onToggleEnable}>
            {selectedNode?.enable ? "隐藏" : "显示"}
          </Button>
        </Space>
        {tree.length ? (
          <Tree
            blockNode
            treeData={treeData}
            defaultExpandAll
            selectedKeys={selectedId ? [selectedId] : []}
            onSelect={(keys) => {
              const key = keys[0] as string | undefined;
              setSelectedId(key ?? null);
              setSelectedType(key ? (findNode(tree, key)?.type ?? null) : null);
            }}
          />
        ) : (
          <div style={{ color: "#999" }}>暂无菜单,请先新建</div>
        )}
      </div>

      <div style={{ flex: 1, padding: 24 }}>
        <Space style={{ marginBottom: 12 }}>
          <Tag color={docStatus === "indexed" ? "green" : docStatus === "failed" ? "red" : "blue"}>
            {docStatus || "未选择"}
          </Tag>
          <Button disabled={selectedType !== "doc" || loading || !editorJson} loading={saving} onClick={onSaveDraft}>
            保存草稿
          </Button>
          <Button disabled={selectedType !== "doc" || loading || !editorJson} type="primary" loading={saving} onClick={onPublish}>
            发布
          </Button>
          {selectedNode && (
            <Link href={`/kb/${kbSlug}?docId=${selectedNode.id}`} target="_blank">
              预览
            </Link>
          )}
        </Space>
        {loading ? (
          <div style={{ color: "#999" }}>加载中…</div>
        ) : selectedType === "doc" && editorJson ? (
          <XybotEditor key={selectedId} embedded editable value={editorJson as any} onChange={(json) => setEditorJson(json as object)} />
        ) : (
          <div style={{ color: "#999", marginTop: 80, textAlign: "center" }}>
            {selectedType === "folder" ? "已选中文件夹,可在左侧新建子节点" : "请选择左侧文档进行编辑"}
          </div>
        )}
      </div>
    </div>
  );
}
