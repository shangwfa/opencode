"use client";

import { Image as AntdImage, Typography, Space } from "antd";
import { defineComponent } from "@openuidev/react-lang";
import { z } from "zod";

const ImageSchema = z.object({
  src: z.string(),
  alt: z.string().optional(),
});

export const Image = defineComponent({
  name: "Image",
  props: ImageSchema,
  description: "Displays an image with optional alt text.",
  component: ({ props }) => (
    <AntdImage src={props.src} alt={props.alt ?? ""} style={{ borderRadius: 8, maxWidth: "100%" }} />
  ),
});

const ImageBlockSchema = z.object({
  src: z.string(),
  alt: z.string().optional(),
  caption: z.string().optional(),
});

export const ImageBlock = defineComponent({
  name: "ImageBlock",
  props: ImageBlockSchema,
  description: "Image with optional caption.",
  component: ({ props }) => (
    <Space orientation="vertical" size={4} style={{ width: "100%", textAlign: "center" }}>
      <AntdImage src={props.src} alt={props.alt ?? ""} style={{ borderRadius: 8, maxWidth: "100%" }} />
      {props.caption && (
        <Typography.Text type="secondary" style={{ fontSize: 13 }}>
          {props.caption}
        </Typography.Text>
      )}
    </Space>
  ),
});