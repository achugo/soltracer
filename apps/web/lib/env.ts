import { webEnvSchema, type WebEnv } from "@soltracer/shared";

let cached: WebEnv | undefined;

/** Server-side env. Never import this from a client component. */
export function webEnv(): WebEnv {
  cached ??= webEnvSchema.parse(process.env);
  return cached;
}
