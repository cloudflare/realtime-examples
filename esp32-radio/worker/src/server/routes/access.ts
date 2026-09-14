import { Hono } from 'hono';
import { loginSchema } from '@/shared/contracts/signaling.ts';
import { login } from '@/server/auth.ts';
import type { HttpApp } from '@/server/http.ts';
import { input, result, room } from './context.ts';

const app = new Hono<HttpApp>();
app.post('/login', async (c) => login((await input(c, loginSchema)).password, c));
app.get('/status', async (c) => result(c, await room(c).getStatus()));

export default app;
