import React, { useState, useEffect } from "react";
import { MinusCircleOutlined, PlusOutlined } from "@ant-design/icons";
import { Modal, Button, Form, Input, Space, message } from "antd";
import { useRouter } from "next/router";

import { getDocAliasById, updateAlias } from "@/api/admin";
import { MenuItemType, type MenuData, type ResBasic } from "@/api/index.d";

interface ActionData {
  type: string;
  action: string;
}

interface DirectAddProps {
  isVisible: boolean;
  actionData: ActionData;
  nodeData?: MenuData;
  onCancel: () => void;
}

export default ({
  isVisible,
  actionData,
  nodeData,
  onCancel,
}: DirectAddProps) => {
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [form] = Form.useForm();
  const [btnLoading, setBtnLoading] = useState(false);

  useEffect(() => {
    setIsModalOpen(isVisible);
    if (isVisible) {
      getDocAlias();
    }
  }, [isVisible]);

  const getDocAlias = () => {
    getDocAliasById({
      docId: nodeData?.id || "",
    }).then((res) => {
      if (res.code === 200) {
        const aliasList =
          res.data?.map((item) => ({
            aliasItem: item.alias,
          })) || [];
        form.setFieldsValue({
          aliasList,
        });
      }
    });
  };

  const handleOk = async () => {
    const formData = await form.validateFields();
    setBtnLoading(true);
    let params = {
      docId: nodeData?.id || "",
      aliasList: formData.aliasList.map((item) => item.aliasItem),
    };

    let result: ResBasic<any> = {
      code: 0,
      data: null,
    };

    result = await updateAlias(params);
    setBtnLoading(false);
    if (result.code === 200) {
      message.success("别名设置成功");
      onCancel();
    } else {
      message.error(result.message || "别名设置失败");
    }
  };

  const handleCancel = () => {
    onCancel();
  };

  return (
    <Modal
      title="设置别名"
      open={isModalOpen}
      onOk={handleOk}
      onCancel={handleCancel}
      okText="确定"
      cancelText="取消"
      confirmLoading={btnLoading}
    >
      <Form name="wrap" form={form} style={{ marginTop: 32 }}>
        <Form.List name="aliasList">
          {(fields, { add, remove }) => (
            <>
              {fields.map(({ key, name, ...restField }, index) => (
                <Space
                  key={key}
                  style={{ display: "flex", marginBottom: 8 }}
                  align="baseline"
                >
                  <Form.Item
                    {...restField}
                    label={`别名${index + 1}`}
                    name={[name, "aliasItem"]}
                    rules={[
                      { required: true, message: "别名不能为空" },
                      { max: 200, message: "别名不能超过200字符" },
                      {
                        pattern: /^(?!\/).+/,
                        message: "别名开头不能包含斜杠",
                      },
                    ]}
                  >
                    <Input placeholder="请输入别名" className="w-[350px]" />
                  </Form.Item>
                  <MinusCircleOutlined onClick={() => remove(name)} />
                </Space>
              ))}
              <Form.Item wrapperCol={{ span: 24 }}>
                <Button
                  type="dashed"
                  onClick={() => add()}
                  block
                  icon={<PlusOutlined />}
                >
                  添加别名
                </Button>
              </Form.Item>
            </>
          )}
        </Form.List>
      </Form>
    </Modal>
  );
};
