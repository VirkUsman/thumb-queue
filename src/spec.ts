import { createHash } from "node:crypto";

export const FORMATS = ["webp", "jpeg", "png"] as const;
export type Format = (typeof FORMATS)[number];

export interface ThumbSpec {
  width: number;
  height: number;
  format: Format;
}

export interface ThumbJob extends ThumbSpec {
  src: string;
  hash: string;
}

export function validateSpec(spec: ThumbSpec): ThumbSpec {
  for (const k of ["width", "height"] as const) {
    const v = spec[k];
    if (!Number.isInteger(v) || v < 16 || v > 4096) {
      throw new Error(`${k} must be a whole number from 16 to 4096, got ${v}`);
    }
  }
  if (!FORMATS.includes(spec.format)) {
    throw new Error(`format must be one of ${FORMATS.join(", ")}, got ${spec.format}`);
  }
  return spec;
}

export function contentHash(data: Uint8Array): string {
  return createHash("sha256").update(data).digest("hex");
}

// The idempotency key. Same bytes and same target shape give the same key, so
// a second enqueue of an identical upload lands on the same job id.
export function jobKey(hash: string, spec: ThumbSpec): string {
  return `${hash.slice(0, 32)}-${spec.width}x${spec.height}-${spec.format}`;
}
