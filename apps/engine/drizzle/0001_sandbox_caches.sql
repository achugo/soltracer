CREATE TABLE "idl_cache" (
	"program" text PRIMARY KEY NOT NULL,
	"found" boolean NOT NULL,
	"errors" jsonb,
	"fetched_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "lookup_table_cache" (
	"address" text PRIMARY KEY NOT NULL,
	"addresses" text[] NOT NULL,
	"slot" bigint,
	"fetched_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "mint_cache" (
	"mint" text PRIMARY KEY NOT NULL,
	"decimals" smallint NOT NULL,
	"program" text NOT NULL,
	"fetched_at" timestamp with time zone DEFAULT now() NOT NULL
);
