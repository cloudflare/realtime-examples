import type { Context } from 'hono';
import type { z } from 'zod';
import { body, parse, rpcResponse } from '@/server/http.ts';
import type { HttpApp } from '@/server/http.ts';

export const room = (c: Context<HttpApp>) => c.env.ROBOTS.getByName(c.env.ROBOT_NAME);
export const result = <T>(c: Context<HttpApp>, value: Parameters<typeof rpcResponse<T>>[0]) =>
  rpcResponse(value, c.get('requestId'));
export const input = async <T>(c: Context<HttpApp>, schema: z.ZodType<T>) =>
  parse(schema, await body(c.req.raw));
