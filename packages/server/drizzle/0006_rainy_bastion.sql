CREATE TABLE "watch_regions" (
	"user_id" text PRIMARY KEY NOT NULL,
	"region" text,
	"detected_region" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "watch_regions" ADD CONSTRAINT "watch_regions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;