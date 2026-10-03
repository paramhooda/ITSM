CREATE TABLE "shift_handovers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"team_id" uuid NOT NULL,
	"shift_id" uuid,
	"shift_date" date NOT NULL,
	"author_id" uuid,
	"status" text DEFAULT 'draft' NOT NULL,
	"ai_draft" text,
	"body" text DEFAULT '' NOT NULL,
	"facts" jsonb,
	"published_at" timestamp with time zone,
	"acknowledged_by" uuid,
	"acknowledged_at" timestamp with time zone,
	"acknowledgement_note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "team_shifts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"team_id" uuid NOT NULL,
	"name" text NOT NULL,
	"start_time" text NOT NULL,
	"end_time" text NOT NULL,
	"days" integer[] DEFAULT '{1,2,3,4,5,6,7}' NOT NULL,
	"timezone" text DEFAULT 'UTC' NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "shift_handovers" ADD CONSTRAINT "shift_handovers_team_id_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shift_handovers" ADD CONSTRAINT "shift_handovers_shift_id_team_shifts_id_fk" FOREIGN KEY ("shift_id") REFERENCES "public"."team_shifts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shift_handovers" ADD CONSTRAINT "shift_handovers_author_id_users_id_fk" FOREIGN KEY ("author_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shift_handovers" ADD CONSTRAINT "shift_handovers_acknowledged_by_users_id_fk" FOREIGN KEY ("acknowledged_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "team_shifts" ADD CONSTRAINT "team_shifts_team_id_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "shift_handovers_team_idx" ON "shift_handovers" USING btree ("team_id","shift_date");--> statement-breakpoint
CREATE INDEX "shift_handovers_status_idx" ON "shift_handovers" USING btree ("status");--> statement-breakpoint
CREATE INDEX "team_shifts_team_idx" ON "team_shifts" USING btree ("team_id","sort_order");