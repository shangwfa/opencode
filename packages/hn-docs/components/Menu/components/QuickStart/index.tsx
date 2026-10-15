import React, { useState } from "react";
import { BulbOutlined, MoreOutlined } from "@ant-design/icons";
import { Dropdown } from "antd";
import { useRouter } from "next/router";

import DirectAdd from "../DirectAdd";
import DocumentAdd from "../DocumentAdd";

import { MenuItemType } from "@/api/index.d";
import { ActionType } from "./../../index.d";

import { useSharedData } from "@/context/SharedDataContext";
import { getLang } from "@/utils/getLang";

interface Props {
  languageCode: string;
  brandCode: string;
  onUpdateMenu: (id?: string) => void;
}

export default ({
  brandCode,
  languageCode,
  onUpdateMenu,
}: Props) => {
  const [isDirectVisible, setIsDirectVisible] = useState(false);
  const [actionData, setActionData] = useState({
    type: "",
    action: "",
    brandCode: "",
    languageCode: "",
  });
  const [isDocumentVisible, setIsDocumentVisible] = useState(false);
  const router = useRouter();
  const { from } = router.query;
  const { sharedData, updateSharedData } = useSharedData();

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

  const onMenuAction = (type: MenuItemType, action: ActionType) => {
    if (type === MenuItemType.FOLDER && action === ActionType.ADD) {
      setActionData({ type, action, brandCode, languageCode });
      setIsDirectVisible(true);
      return;
    }

    if (type === MenuItemType.DOC && action === ActionType.ADD) {
      setActionData({ type, action, brandCode, languageCode });
      setIsDocumentVisible(true);
      return;
    }
  };

  const items = [
    {
      label: (
        <a
          onClick={() => onMenuAction(MenuItemType.FOLDER, ActionType.ADD)}
          data-bury-id="81045fa1-54a8-4b32-8c6f-3332b2ceaf34"
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
          data-bury-id="eb9bb61b-fcd2-498f-94ff-57d151779e8c"
        >
          新建文档
        </a>
      ),
      key: "add",
    },
  ];

  const onJumpQuickStart = () => {
    updateSharedData({
      id: "",
      docUniqueId: "",
      languageCode,
      brandCode,
      menus: sharedData.menus,
    });
    router.push(`/${brandCode}/${languageCode}?${from ? `from=${from}` : ""}`);
  };

  return (
    <>
      <div className="flex items-center justify-between mb-[32px] whitespace-nowrap">
        <span className="cursor-pointer">
          <BulbOutlined style={{ color: "#4E5969" }} />
          <a
            className="ml-2 text-gray-600 font-medium text-[14px] font-pingfang"
            onClick={onJumpQuickStart}
            data-bury-id="a8780920-ec88-49b6-8c87-5c85d599a0dc"
          >
            {getLang("quick_start")}
          </a>
        </span>
        <span
          className="cursor-pointer flex items-center justify-center w-[24px] h-[24px] text-base text-primary transition duration-350 ease-in-out rounded-lg hover:bg-gray-300 mr-[2px]"
          onClick={(e) => e.stopPropagation()}
          data-bury-id="0a0faf17-8122-4611-87ec-317310710f4d"
        >
          <Dropdown
            menu={{
              items,
            }}
            placement="bottom"
            trigger={["click"]}
          >
            <MoreOutlined />
          </Dropdown>
        </span>
      </div>
      <DirectAdd
        isVisible={isDirectVisible}
        onCancel={onCancel}
        actionData={actionData}
      />
      <DocumentAdd
        isVisible={isDocumentVisible}
        onCancel={onCancel}
        actionData={actionData}
      />
    </>
  );
};
