"use client";

import { Avatar as AntdAvatar } from "antd";
import { defineComponent } from "@openuidev/react-lang";
import { z } from "zod";

const AvatarSchema = z.object({
  src: z.string().optional(),
  alt: z.string().optional(),
  fallback: z.string(),
});

export const Avatar = defineComponent({
  name: "Avatar",
  props: AvatarSchema,
  description: "Circular avatar with image and fallback text.",
  component: ({ props }) => (
    <AntdAvatar src={props.src} alt={props.alt ?? ""} size={40}>
      {props.fallback}
    </AntdAvatar>
  ),
});