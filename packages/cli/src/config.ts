import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { C2PA_ALGORITHMS, ImgwandError, type C2paSigningAlgorithm } from "@hrhv/imgwand";
import type { GraphicsProtocol } from "./terminal/capabilities.js";

/**
 * ~/.config/imgwand/config.json (or $XDG_CONFIG_HOME/imgwand/config.json):
 *
 *   {
 *     "graphics": "auto",
 *     "backup": true,
 *     "signer": { "cert": "~/keys/cert.pem", "key": "~/keys/key.pem", "alg": "es256", "tsa": "http://timestamp.example" },
 *     "trustAnchors": "~/keys/anchors.pem"
 *   }
 *
 * Key material is only ever referenced by path; it is read when signing.
 */

export interface SignerConfig {
  readonly cert: string;
  readonly key: string;
  readonly alg: C2paSigningAlgorithm;
  readonly tsa?: string;
}

export interface Config {
  readonly graphics?: GraphicsProtocol | "auto";
  readonly backup?: boolean;
  readonly signer?: SignerConfig;
  readonly trustAnchors?: string;
}

export function configPath(env: NodeJS.ProcessEnv): string {
  const base = env.XDG_CONFIG_HOME || join(env.HOME || homedir(), ".config");
  return join(base, "imgwand", "config.json");
}

export function expandHome(path: string, env: NodeJS.ProcessEnv): string {
  return path === "~" || path.startsWith("~/") ? join(env.HOME || homedir(), path.slice(1)) : path;
}

export function loadConfig(env: NodeJS.ProcessEnv, read: (path: string) => string = (p) => readFileSync(p, "utf8")): Config {
  const path = configPath(env);
  let text: string;
  try {
    text = read(path);
  } catch {
    return {};
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    throw new ImgwandError("INVALID_VALUE", `${path} is not valid JSON: ${(error as Error).message}`);
  }
  if (typeof raw !== "object" || raw === null) throw new ImgwandError("INVALID_VALUE", `${path} must contain a JSON object`);
  const c = raw as Record<string, unknown>;
  const config: { -readonly [K in keyof Config]: Config[K] } = {};
  if (typeof c.graphics === "string") config.graphics = c.graphics as Config["graphics"];
  if (typeof c.backup === "boolean") config.backup = c.backup;
  if (typeof c.trustAnchors === "string") config.trustAnchors = expandHome(c.trustAnchors, env);
  if (c.signer !== undefined) {
    if (typeof c.signer !== "object" || c.signer === null) throw new ImgwandError("INVALID_VALUE", `${path}: signer must be an object with "cert" and "key"`);
    const s = c.signer as Record<string, unknown>;
    if (typeof s.cert !== "string" || typeof s.key !== "string") throw new ImgwandError("INVALID_VALUE", `${path}: signer needs "cert" and "key" paths`);
    const alg = (typeof s.alg === "string" ? s.alg : "es256") as C2paSigningAlgorithm;
    if (!C2PA_ALGORITHMS.includes(alg)) throw new ImgwandError("INVALID_VALUE", `${path}: signer.alg must be one of ${C2PA_ALGORITHMS.join(", ")}`);
    config.signer = { cert: expandHome(s.cert, env), key: expandHome(s.key, env), alg, tsa: typeof s.tsa === "string" ? s.tsa : undefined };
  }
  return config;
}
