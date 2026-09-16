import { z } from 'zod';

const bytes = z.number().int().nonnegative();
const memorySchema = z.object({ free: bytes, minimumFree: bytes, largestBlock: bytes });
const busy = z.number().int().min(0).max(10000).nullable();

export const hardwareSchema = z.object({
  sampledAtMs: z.number().int().nonnegative(),
  cpuBusyBps: z.tuple([busy, busy]),
  chipTemperatureMc: z.number().int().min(-10000).max(80000).nullable(),
  internal: memorySchema,
  psram: memorySchema,
  sampleCostUs: bytes,
  samplerStackFree: bytes,
});

export type Hardware = z.infer<typeof hardwareSchema>;
