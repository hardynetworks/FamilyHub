import { Router } from 'express';
import { getWeather } from '../weather';

export const weatherRouter = Router();

weatherRouter.get('/', async (_req, res) => {
  res.setHeader('Cache-Control', 'private, max-age=300');
  res.json(await getWeather());
});
