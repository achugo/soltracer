CREATE TABLE "runs" (
	"id" uuid PRIMARY KEY NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"wallet" text NOT NULL,
	"engine" text NOT NULL,
	"input" text NOT NULL,
	"overrides" jsonb NOT NULL,
	"result" jsonb NOT NULL
);
--> statement-breakpoint
CREATE INDEX "runs_wallet_created_at_idx" ON "runs" USING btree ("wallet","created_at");