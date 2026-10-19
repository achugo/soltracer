import { engineEnvSchema, type EngineEnv } from "@soltracer/shared";

export type EngineConfig = EngineEnv;

/** Parses the engine env. Throws with the failing keys and reasons, never the values. */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): EngineConfig {
  const result = engineEnvSchema.safeParse(env);
  if (!result.success) {
    const lines = result.error.issues.map((i) => `  ${i.path.join(".")}: ${i.message}`);
    throw new Error(`Invalid engine environment:\n${lines.join("\n")}`);
  }
  return result.data;
}
