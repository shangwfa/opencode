import React, { useState, useEffect } from "react";
import { Button, Upload, Form } from "antd";
import { UploadOutlined } from "@ant-design/icons";
import { type UploadProps } from "antd";
import type { RcFile } from "antd/es/upload";

import { getUploadAddress, uploadFile } from "@/utils/upload";
import { FileType } from "@/api/index.d";
import { useSharedData } from "@/context/SharedDataContext";

interface UploadElementProps {
  iconUrl?: string;
  onChange?: (url: string) => void;
}

export default (props: UploadElementProps) => {
  const { iconUrl, onChange } = props;
  const [fileList, setFileList] = useState<any[]>([]);

  const { sharedData } = useSharedData();

  useEffect(() => {
    if (iconUrl) {
      setFileList([{ url: iconUrl }]);
    }
  }, [iconUrl]);

  // 文件上传
  const normFile = (e: any) => {
    if (Array.isArray(e)) {
      return e;
    }
    return e && e.fileList;
  };

  const onUpload: UploadProps<any>["customRequest"] = async (options) => {
    if (options?.file) {
      const uploadInfo = await getUploadAddress(
        (options?.file as RcFile).name!,
        (options?.file as RcFile).size!,
        FileType.PRODUCT_ASSET,
        sharedData.envCode as string
      );
      if (uploadInfo.uploadUrl) {
        await uploadFile(options?.file as RcFile, uploadInfo.uploadUrl).then(
          () => {
            onChange?.(uploadInfo.key);
            setFileList([{ url: uploadInfo.readUrl }]);
          }
        );
      }
    }
  };

  const onRemove = () => {
    onChange?.("");
    setFileList([]);
  };

  return (
    <Form.Item valuePropName="fileList" getValueFromEvent={normFile} noStyle>
      <Upload
        accept="image/*"
        name="file"
        listType="picture"
        customRequest={onUpload}
        fileList={fileList}
        onRemove={onRemove}
      >
        <Button icon={<UploadOutlined />}>上传</Button>
      </Upload>
    </Form.Item>
  );
};
