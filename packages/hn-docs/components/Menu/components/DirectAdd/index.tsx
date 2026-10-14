import React, { useState, useEffect } from "react";
import { Modal, Form, Input, Radio } from "antd";

import UploadElement from "@/components/UploadElement";

import { useSharedData } from "@/context/SharedDataContext";
import { addMenu, updateMenu } from "@/api/admin";
import { MenuItemType, type MenuData, type ResBasic } from "@/api/index.d";
import { isUrlWithDomain } from "@/utils/document";
import { ActionType } from "./../../index.d";
import { env } from "@/utils/env";

interface ActionData {
  type: string;
  action: string;
  languageCode: string;
  brandCode: string;
}

interface DirectAddProps {
  isVisible: boolean;
  actionData: ActionData;
  nodeData?: MenuData;
  onCancel: (status: boolean, MenuItemType: string) => void;
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
  const { sharedData } = useSharedData();
  const { menus } = sharedData;

  useEffect(() => {
    setIsModalOpen(isVisible);
    if (actionData.action === ActionType.EDIT) {
      form.setFieldsValue(nodeData);
    } else {
      form.setFieldsValue({
        scope: "all",
        name: "",
        iconUrl: "",
        position: "header",
      });
    }
  }, [isVisible]);

  const handleOk = async () => {
    const formData = await form.validateFields();
    setBtnLoading(true);
    let params = {
      brandCode: actionData.brandCode,
      languageCode: actionData.languageCode,
      type: MenuItemType.FOLDER,
      ...formData,
    };
    let result: ResBasic<null> = {
      code: 0,
      data: null,
    };
    if (actionData.action === ActionType.ADD) {
      params = {
        ...params,
        parentId: nodeData?.id || 0,
        previousId: 0,
        // formData.position === "header"
        //   ? 0
        //   : nodeData
        //     ? nodeData?.menuTrees?.[nodeData.menuTrees?.length - 1]?.id
        //     : menus?.[menus?.length - 1]?.id || 0,
      };
      result = await addMenu(params);
    }

    if (actionData.action === ActionType.EDIT) {
      params = {
        ...params,
        id: nodeData?.id || 0,
      };

      if (params.iconUrl && isUrlWithDomain(params.iconUrl)) {
        params.iconUrl = new URL(params.iconUrl).pathname;
      }

      result = await updateMenu(params);
    }

    if (result.code === 200) {
      onCancel(true, MenuItemType.FOLDER);
    }
    setBtnLoading(false);
  };

  const handleCancel = () => {
    setIsModalOpen(false);
    onCancel(false, MenuItemType.FOLDER);
  };

  return (
    <Modal
      title={`${actionData.action === ActionType.ADD ? "新建分组" : "编辑分组"}`}
      open={isModalOpen}
      onOk={handleOk}
      onCancel={handleCancel}
      okText="确定"
      cancelText="取消"
      confirmLoading={btnLoading}
    >
      <Form
        name="wrap"
        form={form}
        labelCol={{ span: 6 }}
        wrapperCol={{ span: 18 }}
        style={{ maxWidth: 600, marginTop: 32 }}
      >
        <Form.Item
          label="分组名称"
          name="name"
          rules={[{ required: true }, { max: 200 }]}
        >
          <Input />
        </Form.Item>
        <Form.Item label="分组icon" name="iconUrl">
          <UploadElement
            iconUrl={
              actionData.action === ActionType.EDIT ? nodeData?.iconUrl : ""
            }
          />
        </Form.Item>
        {env.ENV !== "private" && (
          <Form.Item label="可见范围" name="scope">
            <Radio.Group>
              <Radio value="all">全部</Radio>
              <Radio value="public">仅公有云</Radio>
              <Radio value="private">仅专有云</Radio>
            </Radio.Group>
          </Form.Item>
        )}
        {/* {actionData.action === ActionType.ADD && (
          <Form.Item label="插入位置" name="position">
            <Radio.Group>
              <Radio value="header">头部</Radio>
              <Radio value="footer">尾部</Radio>
            </Radio.Group>
          </Form.Item>
        )} */}
      </Form>
    </Modal>
  );
};
