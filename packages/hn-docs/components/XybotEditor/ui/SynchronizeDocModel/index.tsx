import React, { useEffect, useState } from "react";
import { Table, Modal, message } from "antd";
import type { TableColumnsType, TableProps } from "antd";

import { queryAllDocEnvByBrandCode, contentSync } from "@/api/admin";
import { useSharedData } from "@/context/SharedDataContext";

type TableRowSelection<T extends object = object> =
  TableProps<T>["rowSelection"];

interface DataType {
  docEnvConfigId: string;
  brandName: string;
  brandCode: string;
  languageName: string;
  languageCode: string;
}

interface Props {
  isModalOpen: boolean;
  onCancel: (flag: boolean) => void;
}

export default (props: Props) => {
  const { isModalOpen, onCancel } = props;
  const [selectedRowKeys, setSelectedRowKeys] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);

  const { sharedData } = useSharedData();
  const { brandCode, languageCode } = sharedData;

  const columns: TableColumnsType<DataType> = [
    {
      title: "品牌名称",
      dataIndex: "brandName",
      key: "brandName",
    },
    {
      title: "品牌编码",
      dataIndex: "brandCode",
      key: "brandCode",
    },
    {
      title: "语言名称",
      dataIndex: "languageName",
      key: "languageName",
    },
  ];

  const [dataSource, setDataSource] = useState<DataType[]>([]);

  const handleOk = () => {
    if (selectedRowKeys.length === 0) {
      message.error("请选择需要同步的环境");
      return;
    }
    setLoading(true);
    contentSync({
      docMenuId: sharedData.id,
      sourceDocEnvConfigId:
        dataSource.find(
          (item) =>
            item.brandCode === brandCode && item.languageCode === languageCode
        )?.docEnvConfigId || "",

      targetDocEnvConfigIdList: selectedRowKeys,
    })
      .then(() => {
        onCancel(false);
        message.success("同步成功");
      })
      .finally(() => {
        setLoading(false);
      });
  };

  const handleCancel = () => {
    onCancel(false);
  };

  useEffect(() => {
    if (!isModalOpen) return;
    setSelectedRowKeys([]);
    queryAllDocEnvByBrandList();
  }, [isModalOpen]);

  const queryAllDocEnvByBrandList = () => {
    queryAllDocEnvByBrandCode({ brandCode: brandCode ?? "" }).then((res) => {
      if (res.code === 200) {
        setDataSource(res.data || []);
      }
    });
  };

  const onSelectChange = (newSelectedRowKeys: string[]) => {
    setSelectedRowKeys(newSelectedRowKeys);
  };

  const rowSelection: TableRowSelection<DataType> = {
    selectedRowKeys,
    onChange: onSelectChange as (keys: React.Key[]) => void,
    getCheckboxProps: (record: DataType) => ({
      disabled:
        record.brandCode === brandCode && record.languageCode === languageCode,
      name: record.brandName,
    }),
  };

  return (
    <Modal
      title="批量同步当前文档"
      open={isModalOpen}
      onOk={handleOk}
      onCancel={handleCancel}
      confirmLoading={loading}
    >
      <Table<DataType>
        rowSelection={rowSelection}
        columns={columns}
        dataSource={dataSource}
        rowKey="docEnvConfigId"
        pagination={false}
      />
    </Modal>
  );
};
