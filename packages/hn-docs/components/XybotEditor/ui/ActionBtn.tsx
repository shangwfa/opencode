"use client";
import { useState, useEffect } from "react";
import { Button, message, Modal, Dropdown, Space } from "antd";
import { ExclamationCircleOutlined, DownOutlined } from "@ant-design/icons";

import {
  saveDoc,
  queryAdminDraftContent,
  deleteByMenuIdDraft,
  addDraft,
  updateDraft,
  queryDoc,
} from "@/api/admin";
import {
  createKnowledgeSyncTask,
  findMenuNodeById,
  getKnowledgeBaseName,
  getMenuPath,
} from "@/api/knowledgeBase";
import { FileType } from "@/api/index.d";
import { useSharedData } from "@/context/SharedDataContext";
import { getUploadAddress } from "@/utils/upload";
import { resourceDomain } from "@/utils/resources";
import { isUrlWithDomain } from "@/utils/document";
import { env } from "@/utils/env";

import SynchronizeDocModel from "./SynchronizeDocModel";
import ShareModel from "./ShareModel";

import { type EditorData, type DocInfo, DocActionTypes } from "../types";

interface ActionBtnProps {
  docData: EditorData;
  docInfo: DocInfo;
  editable: boolean;
  editPermissions: boolean;
  onAction: (action: string, data?: DocInfo) => void;
}

enum ContentType {
  OSS = "oss",
  TEXT = "text",
}

let modalInfo = {
  destroy: () => {},
};

export default function ActionBtn({
  docData,
  docInfo,
  editable,
  editPermissions,
  onAction,
}: ActionBtnProps) {
  const { sharedData } = useSharedData();
  const {
    id,
    docUniqueId,
    envCode,
    languageCodeList = [],
    brandCode,
    languageCode,
    menus,
  } = sharedData;
  const [draftId, setDraftId] = useState<string>("");
  const [isSynchronizeDocModel, setIsSynchronizeDocModel] = useState(false);
  const [isShareModel, setIsShareModel] = useState(false);

  const [modal, contextHolder] = Modal.useModal();

  const createPublishSyncTask = async (
    content: EditorData,
    docName?: string,
  ) => {
    const currentMenu = findMenuNodeById(menus, id);
    if (currentMenu?.enable === false) {
      return;
    }
    if (!brandCode || !languageCode || !docUniqueId) {
      console.warn("知识库同步任务缺少必要标识", {
        brandCode,
        languageCode,
        docUniqueId,
      });
      return;
    }

    const { docPath, parentPath } = getMenuPath(menus, id);
    await createKnowledgeSyncTask({
      brandCode,
      languageCode,
      operation: "upsertDocument",
      documents: [
        {
          docUniqueId,
          menuId: id,
          name: currentMenu?.name || docName,
          content,
          docPath,
          parentPath,
        },
      ],
      name: await getKnowledgeBaseName(brandCode, languageCode),
    });
  };

  useEffect(() => {
    if (editable) {
      onSave(DocActionTypes.SAVE_DRAFT, false);
    }
  }, [JSON.stringify(docData)]);

  const onSave = async (type: DocActionTypes, isButtonClick: boolean) => {
    let contentStr = "";
    const newDocData = JSON.parse(JSON.stringify(docData)) as EditorData & {
      content: any[];
    };
    const domain = await resourceDomain();
    let hasFileUploading = false;
    const recursive = (data: { content: any[] }) => {
      data.content.forEach((item: any) => {
        if (
          item.type === "video" ||
          item.type === "image" ||
          item.type === "attachment" ||
          (item.type === "iframe" && item.attrs?.isAttachment)
        ) {
          if (item.attrs?.src)
            item.attrs.src = item.attrs.src.replace(domain, "");
        }
        if (item.type === "rpaFlow" && item.attrs?.["data-blocks"]) {
          const v = item.attrs["data-blocks"];
          if (typeof v === "string" && isUrlWithDomain(v.trim())) {
            item.attrs["data-blocks"] = v.replace(domain, "");
          }
        }
        if (item.type === "board" && item.attrs) {
          for (const key of ["preview-img", "board-data"] as const) {
            const v = item.attrs[key];
            if (typeof v === "string" && isUrlWithDomain(v.trim())) {
              item.attrs[key] = v.replace(domain, "");
            }
          }
        }
        if (item.type === "text") {
          contentStr = `${contentStr}\n${item.text || ""}`;
        }
        if (item.type === "attachment" && item.attrs?.isLoading) {
          hasFileUploading = true;
        }
        if (item.content && Array.isArray(item.content)) {
          recursive(item);
        }
      });
    };

    if (!docData.type && type !== DocActionTypes.SAVE_DRAFT) {
      message.error("请先编辑内容");
      return;
    }

    recursive(newDocData);
    if (hasFileUploading && isButtonClick) {
      message.error("请等待附件上传完成后再进行操作");
      return;
    }

    const uploadInfo = await getUploadAddress(
      DocActionTypes.SAVE_DRAFT === type ? `${docUniqueId}_draft` : docUniqueId,
      (newDocData as any).length ?? 0,
      FileType.DOC,
      envCode,
      docUniqueId,
    );

    if (uploadInfo.uploadUrl) {
      const response = await fetch(uploadInfo.uploadUrl, {
        method: "put",
        headers: {
          contentType: "",
        },
        body: JSON.stringify(newDocData),
        signal: new AbortController().signal,
      });

      if (response.ok) {
        if (type === DocActionTypes.PUBLISH) {
          const params = {
            menuId: id,
            contentType: ContentType.OSS,
            content: uploadInfo.key || "",
            plainTextContent: contentStr,
          };
          saveDoc(params).then(async (res) => {
            if (res.code === 200) {
              try {
                await createPublishSyncTask(newDocData, docInfo.name);
              } catch (error) {
                console.error("创建知识库同步任务失败:", error);
                message.warning("保存成功，但知识库同步任务创建失败");
              }
              message.success("保存成功");
              updateDocInfo(DocActionTypes.PUBLISH);
              setDraftId("");
            } else {
              message.error("保存失败");
            }
          });
        }

        if (type === DocActionTypes.SAVE_DRAFT && !draftId) {
          const params = {
            menuId: id,
            contentType: ContentType.OSS,
            content: uploadInfo.key || "",
          };
          addDraft(params).then((res) => {
            if (res.code === 200) {
              setDraftId(res.data.id);
              if (isButtonClick) {
                message.success("保存成功");
              }
            }
          });
        } else if (type === DocActionTypes.SAVE_DRAFT && isButtonClick) {
          message.success("保存成功");
        }
      }
    }
  };

  const updateDocInfo = (type: DocActionTypes) => {
    queryDoc({ id: id as string }).then((res) => {
      onAction(type, res.data);
    });
  };

  const onReEdit = () => {
    deleteByMenuIdDraft({ menuId: docInfo.menuId }).then(() => {
      setDraftId("");
      updateDocInfo(DocActionTypes.EDIT);
      modalInfo.destroy();
    });
  };

  const onEdit = () => {
    if (docInfo.hasDraft) {
      modalInfo = modal.confirm({
        title: "当前文档有未发布内容，是否继续编辑未发布内容？",
        icon: <ExclamationCircleOutlined />,
        content: "重新编辑将放弃未发布内容，并在已发布内容基础进行编辑",
        cancelText: "取消",
        okText: "继续编辑",
        footer: (_, { OkBtn, CancelBtn }) => (
          <>
            <CancelBtn />
            <Button
              onClick={onReEdit}
              data-bury-id="8021b03f-5396-4b14-b76c-cb3fc16500b3"
            >
              重新编辑
            </Button>
            <OkBtn />
          </>
        ),
        onOk() {
          const params = {
            menuId: docInfo.menuId,
          };
          queryAdminDraftContent(params).then((res) => {
            onAction(DocActionTypes.EDIT_DRAFT, res.data);
            setDraftId(res.data.id);
          });
        },
      });
    } else {
      setDraftId("");
      onAction(DocActionTypes.EDIT, docInfo);
    }
  };

  const onPublish = () => {
    modal.confirm({
      title: "确定发布当前文档？",
      icon: <ExclamationCircleOutlined />,
      onOk() {
        onSave(DocActionTypes.PUBLISH, true);
      },
    });
  };

  const onSynchronize = () => {
    setIsSynchronizeDocModel(true);
  };

  const onSyncKnowledgeBase = () => {
    const currentMenu = findMenuNodeById(menus, id);
    const isDisabled = currentMenu?.enable === false;

    modal.confirm({
      title: "同步到文档agent知识库？",
      icon: <ExclamationCircleOutlined />,
      content: isDisabled
        ? "该文档当前是禁用状态，确认将当前文档信息同步到文档agent知识库？"
        : "确认将当前文档信息同步到文档agent知识库？",
      cancelText: "取消",
      okText: "确认同步",
      async onOk() {
        if (!brandCode || !languageCode || !docUniqueId) {
          message.warning("缺少文档agent知识库同步必要信息");
          return;
        }

        try {
          const { docPath, parentPath } = getMenuPath(menus, id);
          const response = await createKnowledgeSyncTask({
            brandCode,
            languageCode,
            operation: "upsertDocument",
            documents: [
              {
                docUniqueId,
                menuId: id,
                name: currentMenu?.name || docInfo.name,
                content: JSON.parse(JSON.stringify(docData)),
                force: true,
                docPath,
                parentPath,
                metadata: {
                  manualSync: true,
                },
              },
            ],
            name: await getKnowledgeBaseName(brandCode, languageCode),
          });

          if (response) {
            message.success("已创建知识库同步任务");
          } else {
            message.warning("当前环境不支持同步知识库");
          }
        } catch (error) {
          console.error("创建知识库同步任务失败:", error);
          message.error("创建知识库同步任务失败");
        }
      },
    });
  };

  const onCancel = () => {
    setIsSynchronizeDocModel(false);
  };

  const onShare = () => {
    setIsShareModel(true);
  };

  // 文档编辑权限管理已移除:同步入口对所有人放行
  const items = [
    {
      key: "1",
      label: <a onClick={onSynchronize}>同步文档</a>,
    },
    {
      key: "knowledge-base-sync",
      label: <a onClick={onSyncKnowledgeBase}>同步知识库</a>,
    },
    {
      key: "2",
      label: <a onClick={onShare}>分享</a>,
    },
  ];

  const canEdit =
    env.ENV !== "private" ||
    (env.ENV === "private" && docInfo.scope === "private_custom");

  return (
    <div
      className="fixed top-[24px] z-10"
      style={{
        right: languageCodeList?.length > 1 ? "145px" : "20px",
      }}
    >
      {editPermissions && (
        <>
          {canEdit && !editable && (
            <Button
              type="primary"
              onClick={onEdit}
              data-bury-id="0159017a-98dc-478a-a2ee-330af157adb0"
            >
              编辑
            </Button>
          )}
          {canEdit && editable && (
            <Button
              type="primary"
              onClick={() => onSave(DocActionTypes.SAVE_DRAFT, true)}
              data-bury-id="f0d8b1c2-3e4a-4c5b-9f6d-7c8e1b2f3a4b"
            >
              保存草稿
            </Button>
          )}
          {canEdit && editable && (
            <Button
              type="primary"
              className="ml-[12px]"
              onClick={onPublish}
              data-bury-id="72591ae5-417d-42d3-a62b-849b4bce6ec6"
            >
              发布
            </Button>
          )}
          <Dropdown menu={{ items }} placement="bottom" className="ml-[12px]">
            <Button>
              <Space>
                更多
                <DownOutlined />
              </Space>
            </Button>
          </Dropdown>
        </>
      )}

      {contextHolder}
      <SynchronizeDocModel
        isModalOpen={isSynchronizeDocModel}
        onCancel={onCancel}
      />
      <ShareModel
        isModalOpen={isShareModel}
        onCancel={() => setIsShareModel(false)}
      />
    </div>
  );
}
