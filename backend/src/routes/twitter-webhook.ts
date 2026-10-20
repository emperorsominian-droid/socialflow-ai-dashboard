import { Router, Request, Response } from 'express';
import crypto from 'crypto';
import rateLimit from 'express-rate-limit';
import { rawBodyMiddleware } from '../middleware/verifySignature';
import { twitterWebhookQueue, mapTwitterEvent } from '../queues/twitterWebhookQueue';
import { createLogger } from '../lib/logger';
import { config } from '../config/config';

const logger = createLogger('twitter-webhook');

const router = Router();

// Strict rate limit — Twitter sends at most a few hundred events/min per subscription
const limiter = rateLimit({ windowMs: 60_000, max: 300, standardHeaders: true, legacyHeaders: false });

function getSecret(): string {
  const secret = config.TWITTER_WEBHOOK_SECRET;
  if (!secret) throw new Error('TWITTER_WEBHOOK_SECRET is not set');
  return secret;
}

/**
 * GET /webhooks/twitter
 * Twitter CRC (Challenge-Response Check) — required for webhook registration.
 * Twitter sends ?crc_token=<token>; we must respond with an HMAC-SHA256 digest.
 */
router.get('/', limiter, (req: Request, res: Response) => {
  const crcToken = req.query.crc_token as string | undefined;
  if (!crcToken) {
    res.status(400).json({ error: 'Missing crc_token' });
    return;
  }

  try {
    const hmac = crypto
      .createHmac('sha256', getSecret())
      .update(crcToken)
      .digest('base64');

    res.json({ response_token: `sha256=${hmac}` });
  } catch (err) {
    logger.error('CRC challenge failed', { error: (err as Error).message });
    res.status(500).json({ error: 'Server misconfiguration' });
  }
});

/**
 * POST /webhooks/twitter
 * Receives signed Account Activity API events.
 * Validates Twitter's X-Twitter-Webhooks-Signature header, then enqueues events.
 */
router.post('/', limiter, rawBodyMiddleware, async (req: Request, res: Response) => {
  const signature = req.headers['x-twitter-webhooks-signature'] as string | undefined;

  if (!signature) {
    res.status(401).json({ error: 'Missing signature header' });
    return;
  }

  // Verify HMAC-SHA256 signature
  const rawBody: Buffer = (req as any).rawBody;
  let secret: string;
  try {
    secret = getSecret();
  } catch {
    res.status(500).json({ error: 'Server misconfiguration' });
    return;
  }

  const expected =
    'sha256=' + crypto.createHmac('sha256', secret).update(rawBody).digest('base64');

  let valid: boolean;
  try {
    valid = crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(signature));
  } catch {
    valid = false;
  }

  if (!valid) {
    logger.warn('Twitter webhook signature mismatch');
    res.status(401).json({ error: 'Invalid signature' });
    return;
  }

  // Acknowledge immediately — Twitter expects a 200 within 3 seconds
  res.status(200).json({ received: true });

  // Enqueue events asynchronously
  const body = req.body as Record<string, unknown>;
  const jobs = mapTwitterEvent(body);

  if (jobs.length === 0) {
    logger.info('Twitter webhook: no mappable events in payload', { keys: Object.keys(body) });
    return;
  }

  try {
    await twitterWebhookQueue.addBulk(
      jobs.map((job) => ({ name: job.eventType, data: job })),
    );
    logger.info(`Twitter webhook: enqueued ${jobs.length} event(s)`);
  } catch (err) {
    logger.error('Failed to enqueue Twitter webhook events', { error: (err as Error).message });
  }
});

export default router;
