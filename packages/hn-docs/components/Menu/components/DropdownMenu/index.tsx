import React, { useState } from "react";
import { Dropdown, Modal, message } from "antd";
import { MoreOutlined, ExclamationCircleOutlined } from "@ant-design/icons";
import type { MenuProps } from "antd";

import { useSharedData } from "@/context/SharedDataContext";

import DirectAdd from "./../DirectAdd";
import DocumentAdd from "./../DocumentAdd";
import AliasSetting from "../AliasSetting";

import { deleteMenu, menuEnable, menuDisable, queryDoc } from "@/api/admin";
import {
  collectDocumentNodes,
  createKnowledgeSyncTask,
  getKnowledgeBaseName,
  getMenuPath,
  toDeleteSyncDocument,
  type KnowledgeSyncDocument,
} from "@/api/knowledgeBase";
import { type ResBasic, type MenuData, MenuItemType } from "@/api/index.d";
import { ActionType } from "./../../index.d";
import { getDocData } from "@/utils/getDocData";

interface DropdownMenuProps {
  nodeData: MenuData;
  brandCode: string;
  languageCode: string;
  onUpdateMenu: (id?: string) => void;
  /** 完整操作权限（新建/删除/设置可见性）；不传或 true 时按原逻辑全部展示 */
  canEditFull?: boolean;
  /** 仅编辑权限（编辑分组/文档）；不传或 true 时按原逻辑全部展示 */
  canEditLimited?: boolean;
  /** 删除分组/文档权限（brand_admin 无）；不传或 true 时按原逻辑全部展示 */
  canDelete?: boolean;
}
export default ({
  nodeData,
  brandCode,
  languageCode,
  onUpdateMenu,
  canEditFull = true,
  canEditLimited = true,
  canDelete = true,
}: DropdownMenuProps) => {
  const [modal, contextHolder] = Modal.useModal();
  const [isDocumentVisible, setIsDocumentVisible] = useState(false);
  const [isDirectVisible, setIsDirectVisible] = useState(false);
  const [isAliasVisible, setIsAliasVisible] = useState(false);
  const [actionData, setActionData] = useState({
    type: "",
    action: "",
    languageCode: "",
    brandCode: "",
  });

  const { sharedData } = useSharedData();
  const { docEnvConfigReference, menus } = sharedData;

  const createDeleteKnowledgeSyncTask = async (docs: MenuData[]) => {
    const documents = docs.filter((doc) => doc.docUniqueId).map(toDeleteSyncDocument);
    if (!documents.length) return;

    await createKnowledgeSyncTask({
      brandCode,
      languageCode,
      operation: documents.length > 1 ? "batchDeleteDocuments" : "deleteDocument",
      documents,
      name: await getKnowledgeBaseName(brandCode, languageCode),
    });
  };

  const createUpsertKnowledgeSyncTask = async (docs: MenuData[]) => {
    const documents: KnowledgeSyncDocument[] = [];

    for (const doc of docs) {
      if (!doc.docUniqueId) continue;

      const { docPath, parentPath } = getMenuPath(menus, doc.id);
      try {
        const docResponse = await queryDoc({ id: doc.id });
        const content = docResponse.code === 200 ? await getDocData(docResponse.data.content) : undefined;
        documents.push({
          docUniqueId: doc.docUniqueId,
          menuId: doc.id,
          name: docResponse.data?.name || doc.name,
          content,
          docPath,
          parentPath,
        });
      } catch (error: any) {
        documents.push({
          docUniqueId: doc.docUniqueId,
          menuId: doc.id,
          name: doc.name,
          docPath,
          parentPath,
          metadata: {
            sourceFetchError: error?.message || "Failed to fetch published document content",
          },
        });
      }
    }

    if (!documents.length) return;

    await createKnowledgeSyncTask({
      brandCode,
      languageCode,
      operation: documents.length > 1 ? "batchUpsertDocuments" : "upsertDocument",
      documents,
      name: await getKnowledgeBaseName(brandCode, languageCode),
    });
  };

  const handleKnowledgeSyncTaskError = (error: unknown) => {
    console.error("创建知识库同步任务失败:", error);
    message.warning("操作成功，但知识库同步任务创建失败");
  };

  // 菜单操作
  const onMenuAction = (type: string, action: string) => {
    console.log(type, action, nodeData, "data-----");
    // 删除分组
    if (action === ActionType.DELETE && type === MenuItemType.FOLDER) {
      modal.confirm({
        title: `确认删除 ${nodeData.name} 吗？`,
        icon: <ExclamationCircleOutlined />,
        content: `同时删除 ${nodeData.name} 下的所有文档，并且会同步删除当前产品下所有语言的这个分组，请谨慎操作`,
        cancelText: "取消",
        okText: "确认",
        async onOk() {
          const docs = collectDocumentNodes(nodeData);
          deleteMenu({ id: nodeData.id }).then(async (res: ResBasic<null>) => {
            if (res.code === 200) {
              try {
                await createDeleteKnowledgeSyncTask(docs);
              } catch (error) {
                handleKnowledgeSyncTaskError(error);
              }
              message.success("删除成功");
              onUpdateMenu();
            }
          });
        },
      });
      return;
    }

    // 删除文档
    if (action === ActionType.DELETE && type === MenuItemType.DOC) {
      modal.confirm({
        title: `确认删除 ${nodeData.name} 吗？`,
        icon: <ExclamationCircleOutlined />,
        content: `会同步删除当前产品下所有语言的这个文档，请谨慎操作`,
        cancelText: "取消",
        okText: "确认",
        async onOk() {
          deleteMenu({ id: nodeData.id }).then(async (res: ResBasic<null>) => {
            if (res.code === 200) {
              try {
                await createDeleteKnowledgeSyncTask([nodeData]);
              } catch (error) {
                handleKnowledgeSyncTaskError(error);
              }
              message.success("删除成功");
              onUpdateMenu();
            }
          });
        },
      });
      return;
    }

    // 禁用分组
    if (action === ActionType.DISABLE && type === MenuItemType.FOLDER) {
      modal.confirm({
        title: `确认禁用 ${nodeData.name} 吗？`,
        icon: <ExclamationCircleOutlined />,
        content: `同时将禁用 ${nodeData.name} 下的所有文档`,
        cancelText: "取消",
        okText: "确认",
        async onOk() {
          const docs = collectDocumentNodes(nodeData);
          menuDisable({ id: nodeData.id }).then(async (res: ResBasic<null>) => {
            if (res.code === 200) {
              try {
                await createDeleteKnowledgeSyncTask(docs);
              } catch (error) {
                handleKnowledgeSyncTaskError(error);
              }
              message.success("禁用成功");
              onUpdateMenu();
            }
          });
        },
      });
      return;
    }

    // 启用分组
    if (action === ActionType.ENABLE && type === MenuItemType.FOLDER) {
      modal.confirm({
        title: `确认启用 ${nodeData.name} 吗？`,
        icon: <ExclamationCircleOutlined />,
        content: `同时将启用 ${nodeData.name} 下的所有文档`,
        cancelText: "取消",
        okText: "确认",
        async onOk() {
          const docs = collectDocumentNodes(nodeData);
          menuEnable({ id: nodeData.id }).then(async (res: ResBasic<null>) => {
            if (res.code === 200) {
              try {
                await createUpsertKnowledgeSyncTask(docs);
              } catch (error) {
                handleKnowledgeSyncTaskError(error);
              }
              message.success("启用成功");
              onUpdateMenu();
            }
          });
        },
      });
      return;
    }

    // 禁用文档
    if (action === ActionType.DISABLE && type === MenuItemType.DOC) {
      modal.confirm({
        title: `确认禁用 ${nodeData.name} 吗？`,
        icon: <ExclamationCircleOutlined />,
        cancelText: "取消",
        okText: "确认",
        async onOk() {
          menuDisable({ id: nodeData.id }).then(async (res: ResBasic<null>) => {
            if (res.code === 200) {
              try {
                await createDeleteKnowledgeSyncTask([nodeData]);
              } catch (error) {
                handleKnowledgeSyncTaskError(error);
              }
              message.success("禁用成功");
              onUpdateMenu();
            }
          });
        },
      });
      return;
    }

    // 启用文档
    if (action === ActionType.ENABLE && type === MenuItemType.DOC) {
      modal.confirm({
        title: `确认启用 ${nodeData.name} 吗？`,
        icon: <ExclamationCircleOutlined />,
        cancelText: "取消",
        okText: "确认",
        async onOk() {
          menuEnable({ id: nodeData.id }).then(async (res: ResBasic<null>) => {
            if (res.code === 200) {
              try {
                await createUpsertKnowledgeSyncTask([nodeData]);
              } catch (error) {
                handleKnowledgeSyncTaskError(error);
              }
              message.success("启用成功");
              onUpdateMenu();
            }
          });
        },
      });
      return;
    }

    if (
      type === MenuItemType.FOLDER &&
      (action === ActionType.ADD || action === ActionType.EDIT)
    ) {
      setActionData({ type, action, brandCode, languageCode });
      setIsDirectVisible(true);
      return;
    }

    if (
      type === MenuItemType.DOC &&
      (action === ActionType.ADD || action === ActionType.EDIT)
    ) {
      setActionData({ type, action, brandCode, languageCode });
      setIsDocumentVisible(true);
      return;
    }

    if (type === MenuItemType.DOC && action === ActionType.ALIAS) {
      setActionData({ type, action, brandCode, languageCode });
      setIsAliasVisible(true);
      return;
    }
  };

  // 分组操作
  const directMenuList: MenuProps["items"] = [
    {
      label: (
        <a
          onClick={() => onMenuAction(MenuItemType.FOLDER, ActionType.ADD)}
          data-bury-id="0787bce4-72b6-449e-9a60-de5e17fee1b5"
        >
          新建分组
        </a>
      ),
      key: "new",
    },
    {
      label: (
        <a
          onClick={() => onMenuAction(MenuItemType.DOC, ActionType.ADD)}
          data-bury-id="369ba833-2ea0-4f7a-820d-aa051fd4b809"
        >
          新建文档
        </a>
      ),
      key: "add",
    },
  ];

  // 文档目录操作
  const documentMenuList: MenuProps["items"] = [
    {
      label: (
        <a
          onClick={() => onMenuAction(MenuItemType.DOC, ActionType.EDIT)}
          data-bury-id="28c4b4bd-9a7a-49ba-8e73-7d1f1fd9b508"
        >
          编辑
        </a>
      ),
      key: "edit",
    },
    {
      label: (
        <a onClick={() => onMenuAction(MenuItemType.DOC, ActionType.ALIAS)}>
          设置别名
        </a>
      ),
      key: ActionType.ALIAS,
    },
    {
      label: (
        <a
          onClick={() =>
            onMenuAction(
              MenuItemType.DOC,
              nodeData.enable ? ActionType.DISABLE : ActionType.ENABLE
            )
          }
        >
          {nodeData.enable ? "禁用文档" : "启用文档"}
        </a>
      ),
      key: ActionType.DISABLE,
    },
  ];
  // 删除文档操作
  const deleteDocumentMenu = {
    label: (
      <a
        onClick={() => onMenuAction(MenuItemType.DOC, ActionType.DELETE)}
        data-bury-id="8678c0c4-4267-4f32-baad-e071af024ec5"
      >
        删除
      </a>
    ),
    key: "delete",
  };

  const onCancel = (status: boolean, type: MenuItemType, id?: string) => {
    if (type === MenuItemType.FOLDER) {
      setIsDirectVisible(false);
    }
    if (type === MenuItemType.DOC) {
      setIsDocumentVisible(false);
    }

    if (status) {
      onUpdateMenu(id);
    }
  };

  const customMenu =
    nodeData?.scope !== "private_custom" ||
    (nodeData?.scope === "private_custom" && Number(nodeData.parentId) !== 0)
      ? [
          {
            label: (
              <a
                onClick={() =>
                  onMenuAction(MenuItemType.FOLDER, ActionType.EDIT)
                }
              >
                编辑分组
              </a>
            ),
            key: "rename",
          },
          {
            label: (
              <a
                onClick={() =>
                  onMenuAction(
                    MenuItemType.FOLDER,
                    nodeData.enable ? ActionType.DISABLE : ActionType.ENABLE
                  )
                }
              >
                {nodeData.enable ? "禁用分组" : "启用分组"}
              </a>
            ),
            key: ActionType.DISABLE,
          },
        ]
      : [];

  const deleteFolderMenu = {
    label: (
      <a onClick={() => onMenuAction(MenuItemType.FOLDER, ActionType.DELETE)}>
        删除
      </a>
    ),
    key: "delete",
  };

  const enableFolderMenu = {
    label: (
      <a
        onClick={() =>
          onMenuAction(
            MenuItemType.FOLDER,
            nodeData.enable ? ActionType.DISABLE : ActionType.ENABLE
          )
        }
      >
        {nodeData.enable ? "禁用分组" : "启用分组"}
      </a>
    ),
    key: ActionType.DISABLE,
  };

  const canEdit = canEditFull || canEditLimited;
  const folderCustomFiltered =
    customMenu &&
    customMenu.filter((_, i) => (i === 0 ? canEdit : canEditFull));
  const folderItems = docEnvConfigReference
    ? [
        ...(canEditFull ? directMenuList : []),
        ...(folderCustomFiltered || []),
        ...(canDelete ? [deleteFolderMenu] : []),
      ]
    : folderCustomFiltered || [];
  const docItemsFiltered = [
    ...(canEdit ? [documentMenuList[0]] : []),
    ...(canEdit ? [documentMenuList[1]] : []),
    ...(canEditFull ? [documentMenuList[2]] : []),
    ...(canDelete ? [deleteDocumentMenu] : []),
  ];
  const documentItems = canEdit
    ? (docItemsFiltered.filter(Boolean) as MenuProps["items"])
    : [];

  return (
    <>
      <Dropdown
        menu={{
          items:
            nodeData?.type === MenuItemType.FOLDER ? folderItems : documentItems,
        }}
        placement="bottom"
        trigger={["click"]}
      >
        <MoreOutlined />
      </Dropdown>
      {contextHolder}

      <DocumentAdd
        isVisible={isDocumentVisible}
        onCancel={onCancel}
        actionData={actionData}
        nodeData={nodeData}
      />

      <DirectAdd
        isVisible={isDirectVisible}
        onCancel={onCancel}
        actionData={actionData}
        nodeData={nodeData}
      />
      <AliasSetting
        isVisible={isAliasVisible}
        onCancel={() => setIsAliasVisible(false)}
        actionData={actionData}
        nodeData={nodeData}
      />
    </>
  );
};
