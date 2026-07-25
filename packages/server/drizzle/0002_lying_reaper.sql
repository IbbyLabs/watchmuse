CREATE TABLE "llm_configs" (
	"user_id" text PRIMARY KEY NOT NULL,
	"config" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "nl_catalog_cache" (
	"catalog_id" text PRIMARY KEY NOT NULL,
	"payload" text NOT NULL,
	"pool_hash" text NOT NULL,
	"built_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "llm_configs" ADD CONSTRAINT "llm_configs_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "nl_catalog_cache" ADD CONSTRAINT "nl_catalog_cache_catalog_id_catalogs_id_fk" FOREIGN KEY ("catalog_id") REFERENCES "public"."catalogs"("id") ON DELETE cascade ON UPDATE no action;