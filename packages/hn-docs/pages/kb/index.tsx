import { Button, List, Modal, Space, Switch, Tag, message } from "antd";
import Link from "next/link";
import { useEffect, useState } from "react";
import BaseSessionGate from "@/components/BaseSessionGate";

import {
  deleteKnowledgeBase,
  listKnowledgeBases,
  setKnowledgeBasePublic,
  type KnowledgeBaseItem,
} from "@/api/docPlatform";

interface Props {
  initialList: KnowledgeBaseItem[];
  error?: string;
}

export default function KbIndexPage() {
  return <BaseSessionGate><KbIndexContent initialList={[]} /></BaseSessionGate>;
}

function KbIndexContent({ initialList, error }: Props) {
  const [list, setList] = useState<KnowledgeBaseItem[]>(initialList ?? []);

  const refresh = async () => {
    try {
      setList(await listKnowledgeBases());
    } catch (e: any) {
      message.error(e?.message || "刷新失败");
    }
  };
  useEffect(() => { void refresh(); }, []);

  const onTogglePublic = async (item: KnowledgeBaseItem, checked: boolean) => {
    try {
      await setKnowledgeBasePublic(item.id, checked);
      await refresh();
    } catch (e: any) {
      message.error(e?.message || "操作失败");
    }
  };

  const onDelete = (item: KnowledgeBaseItem) => {
    Modal.confirm({
      title: `删除知识库「${item.name}」?`,
      content: "菜单、文档与向量数据将一并删除,不可恢复。",
      okType: "danger",
      onOk: async () => {
        try {
          await deleteKnowledgeBase(item.id);
          message.success("已删除");
          await refresh();
        } catch (e: any) {
          message.error(e?.message || "删除失败");
        }
      },
    });
  };

  return (
    <div style={{ maxWidth: 880, margin: "40px auto", padding: "0 16px" }}>
      <Space style={{ marginBottom: 16, width: "100%", justifyContent: "space-between" }}>
        <h2 style={{ margin: 0 }}>我的知识库</h2>
        <Button type="primary" href={`${process.env.NEXT_PUBLIC_HN_APP_URL || "http://localhost:3001"}/#/knowledge/bases`}>
          前往工作台新建
        </Button>
      </Space>

      {error && <div style={{ color: "#fa541c", marginBottom: 12 }}>加载失败:{error}(请确认 knowledge 服务已启动)</div>}

      <List
        dataSource={list}
        locale={{ emptyText: "还没有知识库，请前往工作台统一创建" }}
        renderItem={(item) => (
          <List.Item
            actions={[
              <Link key="visit" href={`/kb/${item.slug}`}>
                访问
              </Link>,
              <Space key="public" align="center">
                <span style={{ color: "#999" }}>公开</span>
                <Switch size="small" checked={item.isPublic} onChange={(v) => onTogglePublic(item, v)} />
              </Space>,
              <Button key="del" type="link" danger onClick={() => onDelete(item)}>
                删除
              </Button>,
            ]}
          >
            <List.Item.Meta
              title={
                <Space>
                  <span>{item.name}</span>
                  <Tag>{item.slug}</Tag>
                  <Tag color="blue">{item.languageCode || "zh-cn"}</Tag>
                  {item.modes?.map((m) => (
                    <Tag key={m.mode} color="purple">
                      {m.mode}
                    </Tag>
                  ))}
                </Space>
              }
              description={item.description || "—"}
            />
          </List.Item>
        )}
      />

    </div>
  );
}
