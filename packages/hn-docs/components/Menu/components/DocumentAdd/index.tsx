import React, { useState, useEffect } from "react";
import { Modal, Form, Input, Radio } from "antd";
import { useRouter } from "next/router";

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
  onCancel: (status: boolean, type: MenuItemType, id?: string) => void;
}

interface ResData {
  id: string;
  name: string;
  type: MenuItemType;
  slug?: string;
  docUniqueId: string;
}

export default ({
  isVisible,
  actionData,
  nodeData,
  onCancel,
}: DirectAddProps) => {
  const [isModalOpen, setIsModalOpen] = useState(false);

  const [btnLoading, setBtnLoading] = useState(false);
  const [form] = Form.useForm();
  const router = useRouter();
  const { brandCode, from, languageCode } = router.query;
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
        seoKey: "",
        iconUrl: "",
        slug: "",
        position: "header",
      });
    }
  }, [isVisible]);

  const handleOk = async () => {
    const formData = await form.validateFields();
    setBtnLoading(true);
    let params = {
      languageCode: actionData.languageCode,
      brandCode: actionData.brandCode,
      type: MenuItemType.DOC,
      ...formData,
    };

    let result: ResBasic<ResData> = {
      code: 0,
      data: {
        id: "",
        name: "",
        type: MenuItemType.DOC,
        docUniqueId: "",
      },
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
    setBtnLoading(false);
    if (result.code === 200) {
      if (actionData.action === ActionType.ADD) {
        router.push(
          from
            ? `/${brandCode}/${languageCode}/${result.data.docUniqueId}?from=${from}`
            : `/${brandCode}/${languageCode}/${result.data.docUniqueId}`
        );
      }

      onCancel(true, MenuItemType.DOC, result.data.id);
    }
  };

  const handleCancel = () => {
    onCancel(false, MenuItemType.DOC);
  };

  return (
    <Modal
      title={`${actionData.action === ActionType.ADD ? "新建文档" : "编辑文档"}`}
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
          label="文档名称"
          name="name"
          rules={[{ required: true }, { max: 200 }]}
        >
          <Input />
        </Form.Item>
        {env.ENV !== "private" && (
          <Form.Item label="文档SEO关键词" name="seoKey">
            <Input />
          </Form.Item>
        )}
        <Form.Item label="文档icon" name="iconUrl">
          <UploadElement
            iconUrl={
              actionData.action === ActionType.EDIT ? nodeData?.iconUrl : ""
            }
          />
        </Form.Item>

        {/* {actionData.action === ActionType.ADD && (
          <Form.Item
            label="自定义文档路径"
            name="slug"
            validateTrigger="onBlur"
            rules={[
              {
                pattern: /^[^\\\s~`!@#$%^&*()_+=[\]{}|;':",./<>?]*$/,
                message: "自定义路径不支持反斜杠及特殊字符",
              },
            ]}
          >
            <Input placeholder="仅支持一级目录" />
          </Form.Item>
        )} */}
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
