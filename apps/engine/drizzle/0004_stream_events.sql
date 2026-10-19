CREATE TABLE "stream_events" (
	"wallet" text NOT NULL,
	"signature" text NOT NULL,
	"slot" bigint NOT NULL,
	"on_chain_error" jsonb,
	"logs" jsonb NOT NULL,
	"status" text NOT NULL,
	"block_time" bigint,
	"deltas" jsonb,
	"run_id" uuid,
	"replay_outcome_matches" boolean,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "stream_events_wallet_signature_pk" PRIMARY KEY("wallet","signature")
);
--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "source" text DEFAULT 'sandbox' NOT NULL;--> statement-breakpoint
ALTER TABLE "stream_events" ADD CONSTRAINT "stream_events_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "stream_events_page_idx" ON "stream_events" USING btree ("slot" DESC NULLS LAST,"signature" DESC NULLS LAST,"wallet" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "stream_events_status_idx" ON "stream_events" USING btree ("status");