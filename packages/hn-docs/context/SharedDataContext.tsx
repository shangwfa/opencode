import React, { createContext, useContext, useState, useEffect } from "react";
import { type MenuData } from "@/api/index.d";
import { updateLanguageData } from "@/utils/getLang";

interface Languages {
  languageName: string;
  languageCode: string;
}

interface SharedDataType {
  menus: MenuData[];
  id: string;
  docUniqueId: string;
  productCode: string;
  envCode: string;
  languages: Record<string, string>;
  brandCode?: string;
  languageCode?: string;
  /** 品牌 id，来自 envConfig queryByBrandCodeAndLanguageCode 返回的 docBrandId，用于 /api/auth/detail */
  docBrandId?: string;
  docEnvConfigReference: boolean; // 是否为文档基线
  defaultLanguageCode?: string;
  languageCodeList?: Languages[];
  oemInfo: {
    title: string;
    iconUrl: string;
  };
  /** 来自 getUserInfo /user/info/rich 的 grade，如 enterprise */
  userGrade?: string;
}

interface SharedDataContextType {
  sharedData: SharedDataType;
  setSharedData: (
    data: Partial<SharedDataType> | ((prev: SharedDataType) => SharedDataType),
  ) => void;
  updateSharedData: (updates: Partial<SharedDataType>) => void;
}

const defaultSharedData: SharedDataType = {
  menus: [],
  id: "",
  docUniqueId: "",
  productCode: "",
  envCode: "",
  languages: {},
  docEnvConfigReference: false,
  defaultLanguageCode: "",
  languageCodeList: [],
  languageCode: "",
  oemInfo: {
    title: "",
    iconUrl: "",
  },
  userGrade: undefined,
};

const SharedDataContext = createContext<SharedDataContextType>({
  sharedData: defaultSharedData,
  setSharedData: (data) => {},
  updateSharedData: (updates: Partial<SharedDataType>) => {},
});

export const SharedDataProvider = ({ children }) => {
  const [sharedData, setSharedData] =
    useState<SharedDataType>(defaultSharedData);

  const updateSharedData = (updates: Partial<SharedDataType>) => {
    console.log("Updating shared data with:", updates);
    setSharedData((prev) => {
      const newData = { ...prev, ...updates };

      // 同步更新语言管理器
      if (
        updates.languages !== undefined ||
        updates.languageCode !== undefined
      ) {
        updateLanguageData(updates.languages || newData.languages);
      }

      return newData;
    });
  };

  // 初始化语言设置
  useEffect(() => {
    if (
      sharedData.languages ||
      sharedData.languageCode ||
      sharedData.defaultLanguageCode
    ) {
      updateLanguageData(sharedData.languages);
    }
  }, []);

  return (
    <SharedDataContext.Provider
      value={{ sharedData, setSharedData, updateSharedData }}
    >
      {children}
    </SharedDataContext.Provider>
  );
};

export const useSharedData = () => {
  return useContext(SharedDataContext);
};
