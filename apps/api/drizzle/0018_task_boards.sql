CREATE TABLE "board_notes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"team_id" uuid,
	"board" text DEFAULT 'tickets' NOT NULL,
	"body" text NOT NULL,
	"color" text DEFAULT 'amber' NOT NULL,
	"pinned" boolean DEFAULT false NOT NULL,
	"done" boolean DEFAULT false NOT NULL,
	"done_at" timestamp with time zone,
	"shift_date" date,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "board_notes" ADD CONSTRAINT "board_notes_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "board_notes" ADD CONSTRAINT "board_notes_team_id_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "board_notes_user_idx" ON "board_notes" USING btree ("user_id","board");--> statement-breakpoint
CREATE INDEX "board_notes_team_idx" ON "board_notes" USING btree ("team_id");--> statement-breakpoint
CREATE INDEX "ticket_tasks_assignee_status_idx" ON "ticket_tasks" USING btree ("assignee_id","status");--> statement-breakpoint
CREATE INDEX "ticket_tasks_team_status_idx" ON "ticket_tasks" USING btree ("team_id","status");