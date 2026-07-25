CREATE TABLE "catalog_exclusions" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"catalog_id" text NOT NULL,
	"tmdb_id" integer NOT NULL,
	"media_type" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "catalog_exclusions" ADD CONSTRAINT "catalog_exclusions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "catalog_exclusions" ADD CONSTRAINT "catalog_exclusions_catalog_id_catalogs_id_fk" FOREIGN KEY ("catalog_id") REFERENCES "public"."catalogs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "catalog_exclusions_catalog_idx" ON "catalog_exclusions" USING btree ("catalog_id");--> statement-breakpoint
CREATE UNIQUE INDEX "catalog_exclusions_unique" ON "catalog_exclusions" USING btree ("catalog_id","media_type","tmdb_id");