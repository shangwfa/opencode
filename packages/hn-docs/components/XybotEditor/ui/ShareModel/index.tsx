import React from "react";
import { Button, Modal, message, Popover, QRCode } from "antd";
import { PaperClipOutlined } from "@ant-design/icons";

import QRCodeIcon from "/static/icon/QRCode.svg";

interface Props {
  isModalOpen: boolean;
  onCancel: (flag: boolean) => void;
}

export default (props: Props) => {
  const { isModalOpen, onCancel } = props;

  const onCopy = (param?: string) => {
    navigator.clipboard
      .writeText(
        `${window.location.origin + window.location.pathname + (param || "")}`,
      )
      .then(() => {
        message.success("链接已复制到剪贴板");
      })
      .catch(() => {
        message.error("复制链接失败，请手动复制");
      });
  };

  return (
    <Modal
      title="分享文档"
      open={isModalOpen}
      onCancel={() => onCancel(false)}
      footer={null}
    >
      <Button
        type="text"
        onClick={() => onCopy()}
        className="flex items-center mb-2"
      >
        <PaperClipOutlined />
        复制链接
      </Button>
      <Popover
        content={
          <QRCode
            value={window.location.origin + window.location.pathname}
            bordered={false}
          />
        }
        title="扫码分享"
        trigger="click"
      >
        <Button type="text" className="flex items-center mb-2">
          <QRCodeIcon width={16} height={16} className="mr-2" />
          二维码
        </Button>
      </Popover>

      <Button
        type="text"
        className="flex items-center"
        onClick={() => onCopy("?link_source=instructions")}
      >
        <PaperClipOutlined />
        复制到RPA使用说明
      </Button>
    </Modal>
  );
};
