"use client";

import { Card, Carousel as AntdCarousel, Space } from "antd";
import { defineComponent } from "@openuidev/react-lang";
import { z } from "zod";

const CarouselSchema = z.object({
  slides: z.array(z.array(z.any())),
  variant: z.enum(["default", "card"]).optional(),
});

export const Carousel = defineComponent({
  name: "Carousel",
  props: CarouselSchema,
  description:
    'Horizontal sliding content. slides: array of slide arrays. variant: "default" | "card".',
  component: ({ props, renderNode }) => {
    const slides = Array.isArray(props.slides) ? props.slides : [];
    const isCard = props.variant === "card";

    return (
      <AntdCarousel>
        {slides.map((slide, i) => (
          <div key={i}>
            {isCard ? (
              <Card
                styles={{ body: { padding: 16 } }}
                style={{ margin: "0 4px" }}
                variant="borderless"
              >
                <Space orientation="vertical" size={12}>
                  {renderNode(slide)}
                </Space>
              </Card>
            ) : (
              <Space orientation="vertical" size={12}>
                {renderNode(slide)}
              </Space>
            )}
          </div>
        ))}
      </AntdCarousel>
    );
  },
});