"use client";

import { defineComponent } from "@openuidev/react-lang";
import { Prism as SyntaxHighlighter } from "react-syntax-highlighter";
import { oneLight } from "react-syntax-highlighter/dist/esm/styles/prism";
import { z } from "zod";

const CodeBlockSchema = z.object({
  code: z.string(),
  language: z.string().optional(),
  title: z.string().optional(),
});

export const CodeBlock = defineComponent({
  name: "CodeBlock",
  props: CodeBlockSchema,
  description: "Syntax-highlighted code block with optional language and title.",
  component: ({ props }) => {
    const code = props.code == null ? "" : String(props.code);
    const language = props.language?.toLowerCase() || "text";
    return (
      <div className="rounded-lg border bg-muted">
        {props.title && (
          <div className="border-b px-4 py-2 text-xs font-medium text-muted-foreground">
            {props.title}
            {props.language && <span className="ml-2 text-xs opacity-60">{props.language}</span>}
          </div>
        )}
        <SyntaxHighlighter
          language={language}
          style={oneLight}
          customStyle={{ margin: 0, padding: "1rem", background: "transparent" }}
          codeTagProps={{
            className: "text-sm font-mono",
            style: { fontWeight: 400, lineHeight: 1.6, textShadow: "none" },
          }}
        >
          {code}
        </SyntaxHighlighter>
      </div>
    );
  },
});
