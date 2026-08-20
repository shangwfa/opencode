CREATE EXTENSION IF NOT EXISTS pg_trgm;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "codegraph_node" (
	"scope" text NOT NULL,
	"id" text NOT NULL,
	"kind" text NOT NULL,
	"name" text NOT NULL,
	"qualified_name" text NOT NULL,
	"file_path" text NOT NULL,
	"language" text NOT NULL,
	"start_line" integer NOT NULL,
	"end_line" integer NOT NULL,
	"start_col" integer NOT NULL,
	"end_col" integer NOT NULL,
	"docstring" text,
	"signature" text,
	"visibility" text,
	"is_exported" integer DEFAULT 0 NOT NULL,
	"is_async" integer DEFAULT 0 NOT NULL,
	"is_static" integer DEFAULT 0 NOT NULL,
	"is_abstract" integer DEFAULT 0 NOT NULL,
	"decorators" jsonb,
	"type_parameters" jsonb,
	"return_type" text,
	"is_generated" integer DEFAULT 0 NOT NULL,
	"time_updated" bigint NOT NULL,
	-- FTS aligned with codegraph FTS5 (unicode61 ≈ simple dictionary, no
	-- stemming): camelCase boundaries pre-split so sub-words match; weight
	-- ratio mirrors FTS5 name=20 / qualified_name=5 / signature=2 / docstring=1.
	"fts" tsvector GENERATED ALWAYS AS (
		setweight(to_tsvector('simple', regexp_replace(coalesce("name", ''), '([a-z0-9])([A-Z])', '\1 \2', 'g')), 'A') ||
		setweight(to_tsvector('simple', regexp_replace(coalesce("qualified_name", ''), '([a-z0-9])([A-Z])', '\1 \2', 'g')), 'B') ||
		setweight(to_tsvector('simple', coalesce("signature", '')), 'C') ||
		setweight(to_tsvector('simple', coalesce("docstring", '')), 'D')
	) STORED,
	CONSTRAINT "codegraph_node_scope_id_pk" PRIMARY KEY ("scope", "id")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "codegraph_edge" (
	"id" bigserial PRIMARY KEY,
	"scope" text NOT NULL,
	"source" text NOT NULL,
	"target" text NOT NULL,
	"kind" text NOT NULL,
	"metadata" jsonb,
	"line" integer,
	"col" integer,
	"provenance" text
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "codegraph_file" (
	"scope" text NOT NULL,
	"path" text NOT NULL,
	"content_hash" text NOT NULL,
	"language" text NOT NULL,
	"size" integer NOT NULL,
	"node_count" integer DEFAULT 0 NOT NULL,
	"is_generated" integer DEFAULT 0 NOT NULL,
	"indexed_at" bigint NOT NULL,
	"time_created" bigint NOT NULL,
	"time_updated" bigint NOT NULL,
	CONSTRAINT "codegraph_file_scope_path_pk" PRIMARY KEY ("scope", "path")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "codegraph_ref" (
	"id" bigserial PRIMARY KEY,
	"scope" text NOT NULL,
	"from_node_id" text NOT NULL,
	"reference_name" text NOT NULL,
	"reference_kind" text NOT NULL,
	"line" integer NOT NULL,
	"col" integer NOT NULL,
	"file_path" text DEFAULT '' NOT NULL,
	"language" text DEFAULT 'unknown' NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "codegraph_index" (
	"scope" text PRIMARY KEY,
	"state" text DEFAULT 'pending' NOT NULL,
	"files_total" integer DEFAULT 0 NOT NULL,
	"files_done" integer DEFAULT 0 NOT NULL,
	"node_count" integer DEFAULT 0 NOT NULL,
	"edge_count" integer DEFAULT 0 NOT NULL,
	"engine_version" text,
	"error" text,
	"stale_files" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"heartbeat_at" bigint DEFAULT 0 NOT NULL,
	"time_created" bigint NOT NULL,
	"time_updated" bigint NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "codegraph_node_name_idx" ON "codegraph_node" ("scope", "name");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "codegraph_node_lower_name_idx" ON "codegraph_node" ("scope", lower("name"));
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "codegraph_node_file_idx" ON "codegraph_node" ("scope", "file_path", "start_line");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "codegraph_node_qname_idx" ON "codegraph_node" ("scope", "qualified_name");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "codegraph_node_fts_idx" ON "codegraph_node" USING gin ("fts");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "codegraph_node_name_trgm_idx" ON "codegraph_node" USING gin ("name" gin_trgm_ops);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "codegraph_edge_src_idx" ON "codegraph_edge" ("scope", "source", "kind");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "codegraph_edge_tgt_idx" ON "codegraph_edge" ("scope", "target", "kind");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "codegraph_ref_from_idx" ON "codegraph_ref" ("scope", "from_node_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "codegraph_ref_name_idx" ON "codegraph_ref" ("scope", "reference_name");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "codegraph_ref_pending_idx" ON "codegraph_ref" ("scope", "status") WHERE status = 'pending';
