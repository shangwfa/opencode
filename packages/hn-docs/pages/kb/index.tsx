import { Button, Form, Input, List, Modal, Select, Space, Switch, Tag, message } from "antd";
import type { GetServerSideProps } from "next";
import Link from "next/link";
import { useState } from "react";

import {
  createKnowledgeBase,
  deleteKnowledgeBase,
  knowledgeInternalBaseUrl,
  listKnowledgeBases,
  setKnowledgeBasePublic,
  type KnowledgeBaseItem,
} from "@/api/docPlatform";

interface Props {
  initialList: KnowledgeBaseItem[];
  error?: string;
}

export default function KbIndexPage({ initialList, error }: Props) {
  const [list, setList] = useState<KnowledgeBaseItem[]>(initialList ?? []);
  const [createOpen, setCreateOpen] = useState(false);
  const [form] = Form.useForm();
  const [submitting, setSubmitting] = useState(false);

  const refresh = async () => {
    try {
      setList(await listKnowledgeBases());
    } catch (e: any) {
      message.error(e?.message || "刷新失败");
    }
  };

  const onCreate = async (values: { name: string; slug: string; languageCode: string }) => {
    setSubmitting(true);
    try {
      await createKnowledgeBase(values);
      message.success("创建成功");
      setCreateOpen(false);
      form.resetFields();
      await refresh();
    } catch (e: any) {
      message.error(e?.message || "创建失败");
    } finally {
      setSubmitting(false);
    }
  };

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
        <Button type="primary" onClick={() => setCreateOpen(true)}>
          新建知识库
        </Button>
      </Space>

      {error && <div style={{ color: "#fa541c", marginBottom: 12 }}>加载失败:{error}(请确认 knowledge 服务已启动)</div>}

      <List
        dataSource={list}
        locale={{ emptyText: "还没有知识库,点击右上角新建" }}
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

      <Modal
        title="新建知识库"
        open={createOpen}
        onCancel={() => setCreateOpen(false)}
        onOk={() => form.submit()}
        confirmLoading={submitting}
        destroyOnClose
      >
        <Form form={form} layout="vertical" onFinish={onCreate} initialValues={{ languageCode: "zh-cn" }}>
          <Form.Item name="name" label="名称" rules={[{ required: true, message: "请输入名称" }]}>
            <Input placeholder="例如:产品帮助中心" maxLength={255} />
          </Form.Item>
          <Form.Item
            name="slug"
            label="访问地址(slug)"
            rules={[
              { required: true, message: "请输入 slug" },
              { pattern: /^[a-z0-9][a-z0-9-]{2,63}$/, message: "3-64 位小写字母/数字,可含连字符" },
            ]}
            extra="公开访问地址:/kb/{slug}"
          >
            <Input placeholder="例如:product-help" addonBefore="/kb/" />
          </Form.Item>
          <Form.Item name="languageCode" label="语言">
            <Select
              options={[
                { value: "zh-cn", label: "简体中文" },
                { value: "en-us", label: "English" },
              ]}
            />
          </Form.Item>
        </Form>
      </Modal>
    </div>
  );
}

export const getServerSideProps: GetServerSideProps<Props> = async () => {
  try {
    const res = await fetch(`${knowledgeInternalBaseUrl()}/api/doc-platform/kb-admin/knowledge-bases`, {
      cache: "no-store",
    });
    const json = await res.json();
    if (json?.code === 200) {
      return { props: { initialList: json.data ?? [] } };
    }
    return { props: { initialList: [], error: json?.message || "未知错误" } };
  } catch (e: any) {
    return { props: { initialList: [], error: e?.message || "knowledge 服务不可达" } };
  }
};
